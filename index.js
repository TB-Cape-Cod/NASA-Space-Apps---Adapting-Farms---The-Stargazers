/* =====================================================================
   Greener Farms: index.js
   Pipeline: location -> NASA POWER + USDA SSURGO -> field profile
             -> crop suitability filter -> rotation scoring -> display
   ===================================================================== */

/* ---------------------------------------------------------------------
   1. DATA FETCHING
   --------------------------------------------------------------------- */

// NASA POWER: daily climate. Returns null on failure so the manual dropdowns can take over.
async function fetchNasaPowerData(lat, lon) {
    try {
        const url = `https://power.larc.nasa.gov/api/temporal/daily/point?parameters=T2M_MAX,T2M_MIN,PRECTOTCORR,GWETROOT&community=AG&longitude=${lon}&latitude=${lat}&start=20210101&end=20251231&format=JSON`;

        const response = await fetch(url);
        const data = await response.json();
        if (!data.properties || !data.properties.parameter) return null;

        const maxT = data.properties.parameter.T2M_MAX;
        const minT = data.properties.parameter.T2M_MIN;
        const rain = data.properties.parameter.PRECTOTCORR;
        const soilMoisture = data.properties.parameter.GWETROOT; // 0 = bone dry, 1 = saturated (MERRA-2 model, not SMAP)

        let totalRain = 0, frostDays = 0, heatDays = 0, moistureSum = 0, validDays = 0;
        const monthlyRain = Array(12).fill(0);
        const monthlyHeat = Array(12).fill(0);
        const monthlyWetSum = Array(12).fill(0);
        const monthlyWetN = Array(12).fill(0);
        const yearlyRain = {};
        const yearlyWetSum = {}, yearlyWetN = {};

        for (const date in rain) {
            // -999 means missing in POWER. Check every variable we use.
            if (rain[date] === -999 || soilMoisture[date] === -999 ||
                minT[date] === -999 || maxT[date] === -999) continue;

            const year = date.slice(0, 4);
            const month = +date.slice(4, 6) - 1; // 0 = January

            totalRain += rain[date];
            moistureSum += soilMoisture[date];
            if (minT[date] <= 0) frostDays++;
            if (maxT[date] >= 32) { heatDays++; monthlyHeat[month]++; }
            validDays++;

            monthlyRain[month] += rain[date];
            monthlyWetSum[month] += soilMoisture[date];
            monthlyWetN[month]++;
            yearlyRain[year] = (yearlyRain[year] || 0) + rain[date];
            yearlyWetSum[year] = (yearlyWetSum[year] || 0) + soilMoisture[date];
            yearlyWetN[year] = (yearlyWetN[year] || 0) + 1;
        }

        const years = Object.keys(yearlyRain);
        if (!years.length || !validDays) return null;
        const nYears = years.length;

        const r = monthlyRain.map(v => Math.round(v / nYears)); // avg mm per calendar month
        const w = monthlyWetSum.map((s, i) => monthlyWetN[i] ? +(s / monthlyWetN[i]).toFixed(2) : null);
        const avgOf = (arr, idxs) => +(idxs.reduce((s, i) => s + (arr[i] ?? 0), 0) / idxs.length).toFixed(2);

        // Year-to-year variability: coefficient of variation of annual rain (std dev / mean)
        const annual = years.map(y => yearlyRain[y]);
        const mean = annual.reduce((a, b) => a + b, 0) / nYears;
        const sd = Math.sqrt(annual.reduce((s, v) => s + (v - mean) ** 2, 0) / nYears);

        return {
            // annual summaries
            avgAnnualRainMM: Math.round(totalRain / nYears),
            avgFrostDaysPerYear: Math.round(frostDays / nYears),
            avgHeatDaysPerYear: Math.round(heatDays / nYears),
            avgMonthlyHeatDays: monthlyHeat.map(v => +(v / nYears).toFixed(1)),   // days >= 32C per calendar month
            avgRootZoneWetness: +(moistureSum / validDays).toFixed(2),

            // seasonal rain
            avgMonthlyRainMM: r,
            springRainMM: r[2] + r[3] + r[4],   // Mar-May
            summerRainMM: r[5] + r[6] + r[7],   // Jun-Aug
            autumnRainMM: r[8] + r[9] + r[10],  // Sep-Nov
            winterRainMM: r[11] + r[0] + r[1],  // Dec-Feb

            // seasonal root-zone wetness (0-1)
            avgMonthlyWetness: w,
            springWetness: avgOf(w, [2, 3, 4]),
            summerWetness: avgOf(w, [5, 6, 7]),
            autumnWetness: avgOf(w, [8, 9, 10]),
            winterWetness: avgOf(w, [11, 0, 1]),

            // year-to-year variability
            yearlyRainMM: Object.fromEntries(years.map(y => [y, Math.round(yearlyRain[y])])),
            yearlyWetness: Object.fromEntries(years.map(y => [y, +(yearlyWetSum[y] / yearlyWetN[y]).toFixed(2)])),
            rainVariabilityPct: Math.round((sd / mean) * 100),
            yearsOfData: nYears
        };
    } catch (err) {
        console.warn("NASA POWER request failed:", err);
        return null;
    }
}

// USDA Soil Data Access (SSURGO). Returns null outside the U.S. or on failure.
async function fetchUsdaSoilData(lat, lon) {
    try {
        const endpoint = "https://sdmdataaccess.sc.egov.usda.gov/Tabular/post.rest";

        // Spatial SQL query finding the dominant soil component at (lon, lat)
        const sqlQuery = `
            SELECT TOP 1
                mu.muname AS soil_name,
                c.drainagecl AS drainage_class,
                ch.om_r AS organic_matter_pct,
                ch.sandtotal_r AS sand_pct,
                ch.claytotal_r AS clay_pct
            FROM mapunit mu
            INNER JOIN component c ON c.mukey = mu.mukey
            INNER JOIN chorizon ch ON ch.cokey = c.cokey
            WHERE mu.mukey IN (
                SELECT * FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('point(${lon} ${lat})')
            )
            AND c.majcompflag = 'Yes'
            ORDER BY c.comppct_r DESC, ch.hzdept_r ASC
        `;

        const response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ format: "JSON+COLUMNNAME", query: sqlQuery })
        });

        const data = await response.json();
        if (!data.Table || data.Table.length < 2) return null;

        const [soilName, drainage, organicMatter, sand, clay] = data.Table[1];
        return {
            soilName,
            drainageClass: drainage,          // e.g., "Well drained" or "Poorly drained"
            organicMatterPct: organicMatter,  // e.g., 2.4 (%)
            sandPct: sand,
            clayPct: clay
        };
    } catch (err) {
        console.warn("USDA soil request failed:", err);
        return null;
    }
}

// Standard XYZ tile URLs for a map overlay (SMAP / MODIS NDVI via NASA GIBS)
function getNasaGibsTileUrl(layerType, z, y, x) {
    const layers = {
        smapMoisture: {
            id: "SMAP_L4_Analyzed_Root_Zone_Soil_Moisture",
            date: "2025-07-15",
            matrix: "GoogleMapsCompatible_Level6"
        },
        vegetationNdvi: {
            id: "MODIS_Terra_NDVI_8Day",
            date: "2025-07-12",
            matrix: "GoogleMapsCompatible_Level9"
        }
    };
    const selected = layers[layerType];
    return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${selected.id}/default/${selected.date}/${selected.matrix}/${z}/${y}/${x}.png`;
}

/* ---------------------------------------------------------------------
   2. CROP MODEL
   --------------------------------------------------------------------- */

// Growing windows as month indexes (0 = Jan). Approximate, Northern Hemisphere.
const SEASON_WINDOWS = {
    spring:    [3, 4, 5, 6],                 // Apr-Jul
    summer:    [4, 5, 6, 7, 8],              // May-Sep
    winter:    [9, 10, 11, 0, 1, 2, 3, 4],   // Oct-May
    cover:     [8, 9, 10, 11, 0, 1, 2, 3],   // Sep-Apr
    perennial: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
};

// Rain and root-zone wetness inside one crop's own growing window.
// The rain a crop needs in its window is its annual minimum scaled by window length.
function growingWindow(crop, weather) {
    const months = SEASON_WINDOWS[crop.season] || SEASON_WINDOWS.perennial;
    const need = Math.round(crop.minRainMM * months.length / 12);
    const got = weather.avgMonthlyRainMM
        ? Math.round(months.reduce((s, m) => s + weather.avgMonthlyRainMM[m], 0))
        : Math.round(weather.avgAnnualRainMM * months.length / 12); // manual-mode fallback

    // Days at 32C or above inside this crop's window (annual count if monthly data is missing)
    const heat = weather.avgMonthlyHeatDays
        ? Math.round(months.reduce((s, m) => s + weather.avgMonthlyHeatDays[m], 0))
        : weather.avgHeatDaysPerYear;

    let wetness = weather.avgRootZoneWetness ?? null;
    if (weather.avgMonthlyWetness) {
        const vals = months.map(m => weather.avgMonthlyWetness[m]).filter(v => v != null);
        if (vals.length) wetness = vals.reduce((a, b) => a + b, 0) / vals.length;
    }
    return { months, need, got, wetness, heat };
}

class Crop {
    constructor({ id, name, category, minRainMM, maxHeatDays, maxFrostDays,
                  needsWellDrained, waterUse, fixesNitrogen, erosionControl, reason, imageId }) {
        Object.assign(this, { id, name, category, minRainMM, maxHeatDays, maxFrostDays,
                              needsWellDrained, waterUse, fixesNitrogen, erosionControl, reason });
        this.imageId = imageId ?? `img_${id}`;   // key for this crop's picture; change to match your image files
        this.season = "summer"; // overwritten by SEASON_BY_ID below
        this.marketValue = null; // approx. gross $/acre, filled from MARKET_VALUE_BY_ID below
    }

    // Returns { suitable, failures, warnings } so the UI can explain every exclusion.
    evaluate(weather, soil, { irrigated = false } = {}) {
        const failures = [], warnings = [];
        const rainProblem = irrigated ? warnings : failures; // irrigation can cover a rain shortfall

        // 1. Annual rain (no buffer)
        if (weather.avgAnnualRainMM < this.minRainMM)
            rainProblem.push(`Annual rain ${weather.avgAnnualRainMM} mm is below the ${this.minRainMM} mm minimum`);

        // 2. Rain inside this crop's growing window
        const win = growingWindow(this, weather);
        if (win.got < win.need)
            rainProblem.push(`Only ${win.got} mm falls in its ${this.season} growing window; needs about ${win.need} mm`);

        // 3. Dry-year check (soft): would the driest recent year have met the minimum?
        if (weather.yearlyRainMM) {
            const driest = Math.min(...Object.values(weather.yearlyRainMM));
            if (driest < this.minRainMM)
                warnings.push(`Driest recent year had ${driest} mm, below the ${this.minRainMM} mm minimum`);
        }

        // 4. Heat (counted inside this crop's own growing window) and frost (annual): hard limits; warn within 15%
        if (win.heat > this.maxHeatDays)
            failures.push(`${win.heat} days at 32°C or above in its ${this.season} growing window exceeds the limit of ${this.maxHeatDays}`);
        else if (win.heat > this.maxHeatDays * 0.85)
            warnings.push(`Heat days in its growing window (${win.heat}) are close to the limit of ${this.maxHeatDays}`);

        if (weather.avgFrostDaysPerYear > this.maxFrostDays)
            failures.push(`${weather.avgFrostDaysPerYear} frost days/yr exceeds the limit of ${this.maxFrostDays}`);
        else if (weather.avgFrostDaysPerYear > this.maxFrostDays * 0.85)
            warnings.push(`Frost days (${weather.avgFrostDaysPerYear}) are close to the limit of ${this.maxFrostDays}`);

        // 5. Soil drainage
        const drain = soil?.drainageClass || "";
        if (this.needsWellDrained) {
            if (/somewhat poorly/i.test(drain)) warnings.push("Soil is somewhat poorly drained; this crop prefers well-drained ground");
            else if (/poorly/i.test(drain)) failures.push(`Soil is ${drain}; this crop needs well-drained ground`);
        }
        if (/excessively/i.test(drain) && this.waterUse === "High")
            warnings.push("Soil is excessively drained; a high-water crop may dry out");

        return { suitable: failures.length === 0, failures, warnings };
    }

    isSuitableFor(weather, soil, options) {
        return this.evaluate(weather, soil, options).suitable;
    }
}

// Approximate thresholds from extension-style guidance (FAO GAEZ / USDA NRCS cover crop chart).
// Verify against those sources before publishing, and label them "approximate" in the UI.
const CROP_DATABASE = [
    // --- MAJOR ROW & GRAIN CASH CROPS ---
    new Crop({ id: "corn", imageId: "img_corn", name: "Field Corn (Maize)", category: "High-Yield Cash Grain",
        minRainMM: 550, maxHeatDays: 45, maxFrostDays: 165, needsWellDrained: true,
        waterUse: "High", fixesNitrogen: false, erosionControl: "Low",
        reason: "High market demand and caloric yield, but requires heavy nitrogen and ample mid-summer moisture." }),
    new Crop({ id: "soybeans", imageId: "img_soybeans", name: "Soybeans", category: "Nitrogen-Fixing Cash Crop",
        minRainMM: 500, maxHeatDays: 45, maxFrostDays: 165, needsWellDrained: false,
        waterUse: "Medium", fixesNitrogen: true, erosionControl: "Low",
        reason: "Fixes atmospheric nitrogen in the soil, cutting fertilizer costs for the following grain crop." }),
    new Crop({ id: "winter_wheat", imageId: "img_winter_wheat", name: "Winter Wheat", category: "Cool-Season Cash Grain",
        minRainMM: 350, maxHeatDays: 55, maxFrostDays: 190, needsWellDrained: true,
        waterUse: "Low", fixesNitrogen: false, erosionControl: "High",
        reason: "Protects bare soil over winter, breaks summer pest cycles, and matures before peak July heat." }),
    new Crop({ id: "spring_wheat", imageId: "img_spring_wheat", name: "Spring Wheat", category: "Northern Cash Grain",
        minRainMM: 320, maxHeatDays: 35, maxFrostDays: 210, needsWellDrained: true,
        waterUse: "Low", fixesNitrogen: false, erosionControl: "Medium",
        reason: "Well-suited to northern climates with severe winters where fall-planted wheat risks winterkill." }),
    new Crop({ id: "sorghum", imageId: "img_sorghum", name: "Grain Sorghum (Milo)", category: "Drought-Tolerant Cash Grain",
        minRainMM: 380, maxHeatDays: 120, maxFrostDays: 160, needsWellDrained: false,
        waterUse: "Low", fixesNitrogen: false, erosionControl: "Medium",
        reason: "Uses ~30% less water than corn and goes dormant during dry spells instead of failing." }),
    new Crop({ id: "barley", imageId: "img_barley", name: "Barley", category: "Short-Season Cash Grain",
        minRainMM: 300, maxHeatDays: 40, maxFrostDays: 205, needsWellDrained: true,
        waterUse: "Low", fixesNitrogen: false, erosionControl: "Medium",
        reason: "Fast-maturing cool-season grain tolerant of drought and mild soil salinity." }),
    new Crop({ id: "oats", imageId: "img_oats", name: "Oats", category: "Cool-Season Grain / Forage",
        minRainMM: 350, maxHeatDays: 35, maxFrostDays: 200, needsWellDrained: false,
        waterUse: "Low", fixesNitrogen: false, erosionControl: "High",
        reason: "Thrives in cooler, wetter regions while suppressing weeds and building soil structure." }),
    new Crop({ id: "triticale", imageId: "img_triticale", name: "Triticale (Wheat-Rye Hybrid)", category: "Resilient Grain / Forage",
        minRainMM: 330, maxHeatDays: 50, maxFrostDays: 200, needsWellDrained: false,
        waterUse: "Low", fixesNitrogen: false, erosionControl: "High",
        reason: "Combines wheat's grain quality with rye's cold hardiness, drought tolerance, and disease resistance." }),

    // --- ROOT, TUBER & SPECIALTY FIELD CROPS ---
    new Crop({ id: "potatoes", imageId: "img_potatoes", name: "Potatoes", category: "High-Value Root / Tuber Crop",
        minRainMM: 500, maxHeatDays: 30, maxFrostDays: 195, needsWellDrained: true,
        waterUse: "High", fixesNitrogen: false, erosionControl: "Low",
        reason: "High per-acre revenue in cool, loose, well-drained soils; requires 3–4 year rotation gaps to prevent blight." }),
    new Crop({ id: "sweet_potatoes", imageId: "img_sweet_potatoes", name: "Sweet Potatoes", category: "Warm-Climate Root Crop",
        minRainMM: 500, maxHeatDays: 120, maxFrostDays: 110, needsWellDrained: true,
        waterUse: "Medium", fixesNitrogen: false, erosionControl: "Medium",
        reason: "Thrives in warm sandy loams with moderate water; leafy vines shade soil and suppress late-summer weeds." }),
    new Crop({ id: "sugarbeets", imageId: "img_sugarbeets", name: "Sugarbeets", category: "Deep-Rooted Cash Crop",
        minRainMM: 450, maxHeatDays: 35, maxFrostDays: 190, needsWellDrained: true,
        waterUse: "Medium", fixesNitrogen: false, erosionControl: "Low",
        reason: "Deep taproot scavenges leftover nitrogen from lower soil layers and pairs well with small grains." }),
    new Crop({ id: "cotton", imageId: "img_cotton", name: "Upland Cotton", category: "Warm-Climate Fiber Crop",
        minRainMM: 500, maxHeatDays: 130, maxFrostDays: 110, needsWellDrained: true,
        waterUse: "Medium", fixesNitrogen: false, erosionControl: "Low",
        reason: "Heat-loving southern cash crop that benefits strongly from rotation with peanuts or winter cover crops." }),
    new Crop({ id: "peanuts", imageId: "img_peanuts", name: "Peanuts", category: "Southern Nitrogen-Fixing Legume",
        minRainMM: 500, maxHeatDays: 120, maxFrostDays: 105, needsWellDrained: true,
        waterUse: "Medium", fixesNitrogen: true, erosionControl: "Low",
        reason: "Fixes significant soil nitrogen in warm sandy soils and disrupts cotton nematode cycles." }),
    new Crop({ id: "tobacco", imageId: "img_tobacco", name: "Flue-Cured / Burley Tobacco", category: "High-Value Specialty Leaf Crop",
        minRainMM: 550, maxHeatDays: 95, maxFrostDays: 125, needsWellDrained: true,
        waterUse: "Medium", fixesNitrogen: false, erosionControl: "Low",
        reason: "High per-acre value in Southeast soils; strongly requires small-grain or fescue rotations to prevent soilborne diseases." }),
    new Crop({ id: "rice", imageId: "img_rice", name: "Rice", category: "Flood-Tolerant Cash Grain",
        minRainMM: 900, maxHeatDays: 110, maxFrostDays: 115, needsWellDrained: false,
        waterUse: "High", fixesNitrogen: false, erosionControl: "High",
        reason: "Ideal for poorly drained heavy clay soils with abundant water where row crops would drown." }),
    // --- OILSEEDS & DRY PULSES ---
    new Crop({ id: "sunflowers", imageId: "img_sunflowers", name: "Oilseed Sunflowers", category: "Deep-Rooted Drought Oilseed",
        minRainMM: 350, maxHeatDays: 100, maxFrostDays: 175, needsWellDrained: true,
        waterUse: "Low", fixesNitrogen: false, erosionControl: "Low",
        reason: "Taproot reaches 5+ feet deep to pull moisture and nutrients out of reach of shallow crops." }),
    new Crop({ id: "canola", imageId: "img_canola", name: "Canola (Rapeseed)", category: "Cool-Season Oilseed",
        minRainMM: 350, maxHeatDays: 35, maxFrostDays: 200, needsWellDrained: true,
        waterUse: "Low", fixesNitrogen: false, erosionControl: "Medium",
        reason: "Breaks cereal disease cycles in wheat rotations and offers strong regional oilseed markets." }),
    new Crop({ id: "flax", imageId: "img_flax", name: "Flaxseed", category: "Cool-Season Oilseed / Fiber",
        minRainMM: 320, maxHeatDays: 35, maxFrostDays: 205, needsWellDrained: true,
        waterUse: "Low", fixesNitrogen: false, erosionControl: "Low",
        reason: "Low-input northern rotation crop that pairs well with wheat and pulses to interrupt fungal pathogens." }),
    new Crop({ id: "dry_beans", imageId: "img_dry_beans", name: "Dry Edible Beans (Pinto / Black)", category: "Short-Season Nitrogen Legume",
        minRainMM: 400, maxHeatDays: 45, maxFrostDays: 175, needsWellDrained: true,
        waterUse: "Medium", fixesNitrogen: true, erosionControl: "Low",
        reason: "Fixes nitrogen and matures in 90–100 days, fitting well between potato or sugarbeet years." }),
    new Crop({ id: "chickpeas", imageId: "img_chickpeas", name: "Chickpeas / Lentils", category: "Dryland Pulse Legume",
        minRainMM: 300, maxHeatDays: 60, maxFrostDays: 180, needsWellDrained: true,
        waterUse: "Low", fixesNitrogen: true, erosionControl: "Low",
        reason: "Thrives in low-rainfall plains while fixing soil nitrogen and conserving moisture for winter wheat." }),

    // --- SOIL-BUILDING COVER & FORAGE CROPS ---
    new Crop({ id: "clover_rye", imageId: "img_clover_rye", name: "Crimson Clover + Cereal Rye", category: "Winter Cover Crop Mix",
        minRainMM: 300, maxHeatDays: 80, maxFrostDays: 195, needsWellDrained: false,
        waterUse: "Low", fixesNitrogen: true, erosionControl: "High",
        reason: "Stops winter rain erosion, boosts organic matter, and adds natural nitrogen before spring cash crops." }),
    new Crop({ id: "hairy_vetch", imageId: "img_hairy_vetch", name: "Hairy Vetch", category: "High-Nitrogen Winter Legume",
        minRainMM: 350, maxHeatDays: 70, maxFrostDays: 190, needsWellDrained: true,
        waterUse: "Low", fixesNitrogen: true, erosionControl: "High",
        reason: "Cold-hardy winter legume capable of supplying 80–120 lbs/acre of natural nitrogen to the next corn crop." }),
    new Crop({ id: "oilseed_radish", imageId: "img_oilseed_radish", name: "Forage / Oilseed Radish", category: "Compaction-Breaking Cover Crop",
        minRainMM: 350, maxHeatDays: 65, maxFrostDays: 185, needsWellDrained: true,
        waterUse: "Medium", fixesNitrogen: false, erosionControl: "High",
        reason: "Deep root 'biodrills' through compacted clay hardpans and winter-kills cleanly before spring planting." }),
    new Crop({ id: "buckwheat", imageId: "img_buckwheat", name: "Buckwheat", category: "Fast Summer Smother / Pollinator Crop",
        minRainMM: 350, maxHeatDays: 50, maxFrostDays: 180, needsWellDrained: false,
        waterUse: "Low", fixesNitrogen: false, erosionControl: "High",
        reason: "Matures in just 60 days to fill mid-summer bare gaps, unlock soil phosphorus, and feed pollinators." }),
    new Crop({ id: "annual_ryegrass", imageId: "img_annual_ryegrass", name: "Annual Ryegrass", category: "Erosion-Control & Subsoil Cover",
        minRainMM: 400, maxHeatDays: 60, maxFrostDays: 185, needsWellDrained: false,
        waterUse: "Medium", fixesNitrogen: false, erosionControl: "High",
        reason: "Dense fibrous root system prevents hillside washouts and improves water infiltration in heavy soils." }),
    new Crop({ id: "alfalfa", imageId: "img_alfalfa", name: "Alfalfa", category: "Perennial Forage Legume",
        minRainMM: 450, maxHeatDays: 55, maxFrostDays: 185, needsWellDrained: true,
        waterUse: "High", fixesNitrogen: true, erosionControl: "High",
        reason: "Multi-year deep roots stabilize hillsides, fix high amounts of nitrogen, and supply livestock hay." }),
    new Crop({ id: "millet", imageId: "img_millet", name: "Proso / Pearl Millet", category: "Emergency Dryland Grain / Forage",
        minRainMM: 280, maxHeatDays: 130, maxFrostDays: 165, needsWellDrained: false,
        waterUse: "Low", fixesNitrogen: false, erosionControl: "Medium",
        reason: "One of the lowest water-requirement grains available; ideal for extreme drought adaptation." })
];

// Growing season per crop. Check against local extension guidance; planting windows vary by region.
const SEASON_BY_ID = {
    corn: "summer", soybeans: "summer", sorghum: "summer", potatoes: "summer",
    sweet_potatoes: "summer", sugarbeets: "summer", cotton: "summer", peanuts: "summer",
    tobacco: "summer", rice: "summer", sunflowers: "summer",
    dry_beans: "summer", buckwheat: "summer", millet: "summer",
    spring_wheat: "spring", barley: "spring", oats: "spring", canola: "spring",
    flax: "spring", chickpeas: "spring",
    winter_wheat: "winter", triticale: "winter",
    clover_rye: "cover", hairy_vetch: "cover", oilseed_radish: "cover", annual_ryegrass: "cover",
    alfalfa: "perennial"
};
CROP_DATABASE.forEach(c => { c.season = SEASON_BY_ID[c.id] || "summer"; });

// Approximate U.S. gross revenue per acre per year (yield x typical price), BEFORE input costs.
// These are rough estimates: verify against USDA NASS QuickStats and AMS Market News, and show
// them as "approximate" in the UI. Cover crops have no direct sale income (0).
const MARKET_VALUE_BY_ID = {
    corn: 850, soybeans: 600, winter_wheat: 420, spring_wheat: 400, sorghum: 400, barley: 400,
    oats: 300, triticale: 320, potatoes: 3500, sweet_potatoes: 4000, sugarbeets: 1500, cotton: 750,
    peanuts: 950, tobacco: 4500, rice: 1000, sunflowers: 450, canola: 450, flax: 380,
    dry_beans: 650, chickpeas: 500, clover_rye: 0, hairy_vetch: 0, oilseed_radish: 0,
    buckwheat: 0, annual_ryegrass: 0, alfalfa: 900, millet: 300
};
CROP_DATABASE.forEach(c => { c.marketValue = MARKET_VALUE_BY_ID[c.id] ?? 0; });

// 0-1 score on a log scale: ~$100/acre = 0, ~$4,500/acre = 1
// (clamp is defined further down, but this is only called later, so the order is fine)
const marketScore = c =>
    clamp((Math.log((c.marketValue || 0) + 1) - Math.log(100)) / (Math.log(4500) - Math.log(100)));

/* ---------------------------------------------------------------------
   3. FIELD PROFILE (live data, or manual dropdowns as fallback)
   --------------------------------------------------------------------- */

// Rough fallback numbers for when the APIs fail or the location is outside the U.S.
const TEMP_FALLBACK = {
    Hot:  { heat: 80, frost: 0 },
    Warm: { heat: 30, frost: 20 },
    Cool: { heat: 8,  frost: 90 },
    Cold: { heat: 0,  frost: 150 }
};
const RAIN_FALLBACK = { "Very Humid": 1300, "Somewhat Humid": 900, "Somewhat Dry": 500, "Very Dry": 250 };

function getManualInputs() {
    const t = document.getElementById("temperature");
    const h = document.getElementById("humidity");
    return { temperature: t ? t.value : "Warm", humidity: h ? h.value : "Somewhat Dry" };
}

function buildProfile(weather, manual) {
    if (weather) return { ...weather, source: "NASA POWER" };
    const temp = TEMP_FALLBACK[manual?.temperature] || TEMP_FALLBACK.Warm;
    return {
        avgAnnualRainMM: RAIN_FALLBACK[manual?.humidity] ?? RAIN_FALLBACK["Somewhat Dry"],
        avgHeatDaysPerYear: temp.heat,
        avgFrostDaysPerYear: temp.frost,
        avgRootZoneWetness: 0.5,
        source: "manual dropdown estimate"
    };
}

/* ---------------------------------------------------------------------
   4. ROTATION RULES (agronomic facts used to order and score crops)
   Approximate, from general extension guidance. Verify locally.
   --------------------------------------------------------------------- */

const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const names = list => list.map(c => c.name).join(", ");
const pct = x => Math.round(x * 100);

const COVER_IDS = new Set(["clover_rye", "hairy_vetch", "oilseed_radish", "buckwheat", "annual_ryegrass"]);
const WATER_USE = { Low: 1, Medium: 0.6, High: 0.2 };  // higher = more water-efficient
const EROSION = { Low: 0, Medium: 0.5, High: 1 };

// Plant family: a crop should never directly follow its own family (disease and pest carryover).
const FAMILY_BY_ID = {
    corn: "grass", sorghum: "grass", winter_wheat: "grass", spring_wheat: "grass", barley: "grass",
    oats: "grass", triticale: "grass", millet: "grass", rice: "grass", annual_ryegrass: "grass",
    soybeans: "legume", dry_beans: "legume", chickpeas: "legume", peanuts: "legume",
    alfalfa: "legume", hairy_vetch: "legume", clover_rye: "legume",
    canola: "brassica", oilseed_radish: "brassica",
    potatoes: "nightshade", tobacco: "nightshade",
    sugarbeets: "beet", cotton: "mallow", sunflowers: "sunflower",
    flax: "flax", sweet_potatoes: "morning-glory", buckwheat: "buckwheat"
};
const familyOf = c => FAMILY_BY_ID[c.id] || c.id;

// Heavy nitrogen feeders do best right after a nitrogen-fixing crop.
const HEAVY_N_IDS = new Set(["corn", "potatoes", "cotton", "tobacco", "sugarbeets", "sorghum", "rice"]);

// Which calendar months a crop keeps living roots in the ground, split into the part that falls
// in the year it is planted and the part that carries into the next calendar year.
function coverageMonths(crop) {
    if (crop.id === "buckwheat") return { same: [6, 7, 8], carry: [] };   // Jul-Sep summer cover
    const win = SEASON_WINDOWS[crop.season] || SEASON_WINDOWS.perennial;
    if (crop.season === "perennial") return { same: win, carry: [0, 1, 2] };   // stand lasts until spring planting of the next crop
    if (crop.season === "winter" || crop.season === "cover") {
        const start = win[0];
        return { same: win.filter(m => m >= start), carry: win.filter(m => m < start) };
    }
    return { same: win, carry: [] };
}

// A cover crop can only go in the gap between two crops if the calendar allows it.
function coverFits(prev, cover, next) {
    if (cover.id === "buckwheat") return prev.season === "winter" || prev.season === "spring";
    const prevEndsEarly = prev.season === "summer" || prev.season === "spring";
    const nextPlantedLate = next.season === "summer" || next.season === "spring" || next.season === "perennial";
    return prevEndsEarly && nextPlantedLate;
}

// Which months of calendar year k have living roots in the ground?
function yearCoverage(seq, k) {
    const n = seq.years.length;
    const prevIdx = (k - 1 + n) % n;
    const covered = new Set();
    coverageMonths(seq.years[k]).same.forEach(m => covered.add(m));
    coverageMonths(seq.years[prevIdx]).carry.forEach(m => covered.add(m));
    if (seq.cover) {
        const cv = coverageMonths(seq.cover.crop);
        if (seq.cover.gaps.includes(k)) cv.same.forEach(m => covered.add(m));
        if (seq.cover.gaps.includes(prevIdx)) cv.carry.forEach(m => covered.add(m));
    }
    return covered;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// {0,1,2,9,10,11} -> "Oct-Mar" (wraps around the new year); a single month -> "Jun"
function monthRange(set) {
    const ms = [...set].sort((a, b) => a - b);
    if (!ms.length) return "none";
    if (ms.length === 12) return "all year";
    const runs = [];
    for (const m of ms) {
        const last = runs[runs.length - 1];
        if (last && m === last[1] + 1) last[1] = m; else runs.push([m, m]);
    }
    if (runs.length > 1 && runs[0][0] === 0 && runs[runs.length - 1][1] === 11) {   // join Dec to Jan
        const tail = runs.pop();
        runs[0][0] = tail[0];
        runs[0].wrap = true;
    }
    return runs.map(r => r[0] === r[1] ? MONTH_NAMES[r[0]] : `${MONTH_NAMES[r[0]]}-${MONTH_NAMES[r[1]]}`).join(", ");
}

// A rotation: { years: [crop, crop, ...], cover: { crop, gaps: [yearIndex, ...] } | null }.
// The cover crop is planted in every gap after a year where the calendar allows it.
// The cycle repeats, so the last year is followed by the first.
// Lines for each calendar year: the main crop, the cover crop planted after it (with months), and bare months.
function describeRotation(seq) {
    const lines = [];
    seq.years.forEach((c, i) => {
        const win = SEASON_WINDOWS[c.season] || SEASON_WINDOWS.perennial;
        lines.push(`Year ${i + 1}: ${c.name} (${c.season} crop, in the ground about ${monthRange(new Set(win))})`);
        if (seq.cover && seq.cover.gaps.includes(i)) {
            const cv = coverageMonths(seq.cover.crop);
            const months = monthRange(new Set([...cv.same, ...cv.carry]));
            lines.push(`    then ${seq.cover.crop.name} as ${seq.cover.crop.id === "buckwheat" ? "a summer cover" : "a fall-to-spring cover"} (${months})${seq.cover.crop.fixesNitrogen ? ", nitrogen-fixing" : ""}`);
        }
        const covered = yearCoverage(seq, i);
        const bare = new Set([...Array(12).keys()].filter(m => !covered.has(m)));
        lines.push(`    ${bare.size ? "Bare ground: " + monthRange(bare) : "No bare months"}`);
    });
    return lines;
}
function rotationTitle(seq) {
    const cover = seq.cover
        ? ` (+ ${seq.cover.crop.name} cover after year${seq.cover.gaps.length > 1 ? "s" : ""} ${seq.cover.gaps.map(g => g + 1).join(", ")})`
        : "";
    return seq.years.map(c => c.name).join(" → ") + cover;
}

// How much of the year is the ground bare, and how much rain lands on it?
function bareSoilStats(seq, profile) {
    const n = seq.years.length;
    let bareMonths = 0, bareRain = 0;
    for (let k = 0; k < n; k++) {
        const covered = yearCoverage(seq, k);
        for (let m = 0; m < 12; m++) {
            if (covered.has(m)) continue;
            bareMonths++;
            bareRain += profile.avgMonthlyRainMM ? profile.avgMonthlyRainMM[m] : profile.avgAnnualRainMM / 12;
        }
    }
    const avgBareRainMM = bareRain / n;
    return {
        avgBareMonths: bareMonths / n,
        avgBareRainMM,
        bareRainFraction: profile.avgAnnualRainMM ? avgBareRainMM / profile.avgAnnualRainMM : 0
    };
}

/* ---------------------------------------------------------------------
   5. SCORING
   --------------------------------------------------------------------- */

// Score weights are judgment calls. They are tunable and shown to the farmer.
const PRESETS = {
    "Soil & erosion focus": { water: 1, soil: 3, climate: 1, rotation: 2, market: 1 },
    "Water resilience":     { water: 3, soil: 1, climate: 1, rotation: 1, market: 1 },
    "Income focus":         { water: 1, soil: 1, climate: 1, rotation: 1, market: 3 },
    "Balanced":             { water: 1, soil: 1, climate: 1, rotation: 1, market: 1 }
};

function totalScore(f, w) {
    const sum = w.water + w.soil + w.climate + w.rotation + w.market;
    return (f.water * w.water + f.soil * w.soil + f.climate * w.climate +
            f.rotation * w.rotation + f.market * w.market) / sum;
}

// Cheap numeric part: five 0-1 factors plus the details needed to explain them.
function computeFactors(seq, profile, soil) {
    const mains = seq.years;
    const all = seq.cover ? [...mains, seq.cover.crop] : mains;
    const n = all.length;
    const avg = fn => all.reduce((s, c) => s + fn(c), 0) / n;

    // Water: crop efficiency + rain slack in each crop's own window + root-zone wetness
    const wins = all.map(c => ({ crop: c, ...growingWindow(c, profile) }));
    const efficiency = avg(c => WATER_USE[c.waterUse]);
    const slack = wins.reduce((s, w) => s + clamp(w.got / w.need - 1), 0) / n;
    const wetness = wins.reduce((s, w) => s + (w.wetness ?? 0.5), 0) / n;
    const water = 0.5 * efficiency + 0.3 * slack + 0.2 * clamp(wetness / 0.6);
    const tightestWater = wins.reduce((a, b) => (b.got / b.need < a.got / a.need ? b : a));

    // Climate headroom below each crop's heat and frost limits
    const margins = all.map(c => ({
        crop: c,
        margin: Math.min(
            (c.maxHeatDays - growingWindow(c, profile).heat) / c.maxHeatDays,
            (c.maxFrostDays - profile.avgFrostDaysPerYear) / c.maxFrostDays
        )
    }));
    const climate = margins.reduce((s, m) => s + clamp(m.margin / 0.5), 0) / n;
    const tightClimate = margins.reduce((a, b) => (b.margin < a.margin ? b : a));

    // Soil: how little rain falls on bare ground + crop erosion-control traits
    const bare = bareSoilStats(seq, profile);
    const bareScore = 1 - clamp(bare.bareRainFraction / 0.5);
    let soilScore = 0.55 * bareScore + 0.45 * avg(c => EROSION[c.erosionControl]);
    if (soil && soil.organicMatterPct != null && soil.organicMatterPct < 2.5 && seq.cover) soilScore += 0.05;
    soilScore = clamp(soilScore);

    // Rotation order: does each heavy nitrogen feeder follow a nitrogen source? How many plant families?
    const m = mains.length;
    const heavy = [];
    mains.forEach((c, i) => {
        if (!HEAVY_N_IDS.has(c.id)) return;
        const pi = (i - 1 + m) % m;
        const prev = mains[pi];
        const viaCover = !!(seq.cover && seq.cover.gaps.includes(pi) && seq.cover.crop.fixesNitrogen);
        heavy.push({ crop: c, prev, viaCover, ok: prev.fixesNitrogen || viaCover });
    });
    const hasLegume = all.some(c => c.fixesNitrogen);
    const nSeq = heavy.length ? heavy.filter(h => h.ok).length / heavy.length : (hasLegume ? 1 : 0.6);
    const families = new Set(mains.map(familyOf));
    const diversity = families.size / Math.max(m, 3);   // a 1- or 2-year rotation cannot reach full diversity
    const rotation = 0.5 * nSeq + 0.5 * diversity;

    // Market: average estimated gross revenue of the main crops (cover crops earn no direct income)
    const market = mains.reduce((s, c) => s + marketScore(c), 0) / mains.length;
    const avgMarketUSD = mains.reduce((s, c) => s + (c.marketValue || 0), 0) / mains.length;

    return {
        factors: { water, soil: soilScore, climate, rotation, market },
        details: { all, wins, tightestWater, tightClimate, wetness, bare, heavy, hasLegume, families, avgMarketUSD }
    };
}

// Expensive text part: reasons, risks, gaps. Only run for the rotations we actually show.
function explainRotation(seq, profile, soil, evalOptions, d, baselineDetails) {
    const reasons = [], risks = [], gaps = [];
    const mains = seq.years;

    // Order and nitrogen
    for (const h of d.heavy) {
        if (h.prev === h.crop) continue;   // single-crop case is flagged separately
        if (h.ok) reasons.push(`${h.crop.name} follows ${h.viaCover ? seq.cover.crop.name + " (a nitrogen-fixing cover)" : h.prev.name + ", a nitrogen fixer"}, so it starts with nitrogen already in the soil.`);
        else risks.push(`${h.crop.name} follows ${h.prev.name}, which does not fix nitrogen; expect higher fertilizer needs.`);
    }
    const legumes = d.all.filter(c => c.fixesNitrogen);
    if (legumes.length) reasons.push(`Nitrogen fixers in the rotation: ${names(legumes)}.`);
    else risks.push("No nitrogen-fixing crop in the rotation; expect higher fertilizer needs.");

    // Shortened rotations (not enough compatible crops for 3 years)
    if (mains.length === 1) risks.push(`Only one compatible main crop (${mains[0].name}) fits this location, so it would be grown every year. That is not a true rotation; expect disease and pest buildup.`);
    else if (mains.length === 2) risks.push("Only two compatible main crops from different plant families fit this location, so this is a 2-year rotation.");

    // Plant families and disease breaks
    if (mains.length > 1) {
        reasons.push(`${d.families.size} plant ${d.families.size === 1 ? "family" : "families"} across ${mains.length} years, and no crop directly follows its own family, which helps break pest and disease cycles.`);
        if (d.families.size < mains.length) risks.push("Two crops in this rotation share a plant family; keep them as far apart as possible to limit disease buildup.");
    }

    // Bare ground and erosion
    let bareLine = `Ground is bare about ${d.bare.avgBareMonths.toFixed(1)} months a year; roughly ${Math.round(d.bare.avgBareRainMM)} mm (${pct(d.bare.bareRainFraction)}%) of yearly rain falls on bare soil (${profile.source}).`;
    if (baselineDetails && baselineDetails !== d)
        bareLine += ` Your existing rotation: ${Math.round(baselineDetails.bare.avgBareRainMM)} mm (${pct(baselineDetails.bare.bareRainFraction)}%).`;
    reasons.push(bareLine);
    if (d.bare.bareRainFraction > 0.35) risks.push("A large share of rain falls on bare ground; erosion and nutrient loss are likely in heavy storms.");
    const guards = d.all.filter(c => c.erosionControl === "High");
    if (guards.length) reasons.push(`High erosion control from ${names(guards)}.`);

    // Water
    const tw = d.tightestWater;
    reasons.push(`Tightest water fit is ${tw.crop.name}: about ${tw.got} mm falls in its ${tw.crop.season} window vs. ~${tw.need} mm needed.`);
    const lowWater = d.all.filter(c => c.waterUse === "Low");
    if (lowWater.length) reasons.push(`${lowWater.length} of ${d.all.length} crops are low-water-use: ${names(lowWater)}.`);
    if (profile.avgMonthlyWetness) reasons.push(`Average root-zone wetness across the growing windows is ${d.wetness.toFixed(2)} on a 0-1 scale (NASA POWER GWETROOT).`);
    const highWater = d.all.filter(c => c.waterUse === "High");
    if (highWater.length && profile.rainVariabilityPct >= 20)
        risks.push(`Annual rain varies by ${profile.rainVariabilityPct}% between years, which is risky for high-water crops (${names(highWater)}).`);

    // Climate
    reasons.push(`Tightest climate fit is ${d.tightClimate.crop.name}: ${growingWindow(d.tightClimate.crop, profile).heat} days at 32°C or above in its growing window, and ${profile.avgFrostDaysPerYear} frost days/yr here (${profile.source}).`);

    // Market
    reasons.push(`Estimated gross market value averages about $${Math.round(d.avgMarketUSD).toLocaleString()}/acre per year across the main crops (approximate national figures, before costs).`);
    if (seq.cover) reasons.push(`${seq.cover.crop.name} has no direct sale income, so it is not counted in market value.`);

    // Soil data
    if (soil && soil.organicMatterPct != null) {
        reasons.push(`Soil organic matter is ${soil.organicMatterPct}% (USDA SSURGO).`);
        if (soil.organicMatterPct < 2.5 && seq.cover) reasons.push("Organic matter is low, so the cover crop adds extra value.");
    }

    // Per-crop suitability notes
    for (const c of d.all) {
        const ev = c.evaluate(profile, soil, evalOptions);
        ev.failures.forEach(f => risks.push(`${c.name}: ${f}`));
        ev.warnings.forEach(w => risks.push(`${c.name}: ${w}`));
    }
    if (d.all.some(c => c.id === "alfalfa")) risks.push("Alfalfa is a perennial stand usually kept 3+ years; here it is treated as one year of the cycle. Adjust to your hay plan.");

    // Information gaps
    if (!soil) gaps.push("No SSURGO soil data for this location (outside the U.S. or no match); drainage and organic matter were not checked.");
    if (soil && soil.drainageClass == null && soil.organicMatterPct == null) gaps.push(`SSURGO matched "${soil.soilName}" but has no drainage or organic matter values there (for example urban land); soil was not checked.`);
    if (profile.source !== "NASA POWER") gaps.push("NASA POWER data was unavailable; climate values are rough estimates from the manual dropdowns, with no seasonal or year-to-year data.");
    gaps.push("Location-level estimates only; no field-scale data (NDVI, ECOSTRESS, slope) yet.");
    gaps.push("Growing seasons are approximated by fixed month windows, not real planting and harvest dates.");
    gaps.push("Crop thresholds and rotation rules are approximate. A local agronomist or extension office should validate this.");
    gaps.push("Market values are rough national gross revenue per acre, not profit and not local prices. Check USDA AMS Market News for your area.");

    const sources = (profile.source === "NASA POWER" ? 1 : 0) + (soil ? 1 : 0);
    const confidence = sources === 2 ? "Medium" : sources === 1 ? "Low-Medium" : "Low";
    return { reasons, risks: [...new Set(risks)], gaps, confidence };
}

/* ---------------------------------------------------------------------
   6. SUITABLE CROPS + ROTATION BUILDING
   --------------------------------------------------------------------- */

function selectSuitableCrops(weatherData, soilData, options = {}, cropDatabase = CROP_DATABASE) {
    const suitable = [], rejected = [];
    for (const crop of cropDatabase) {
        const r = crop.evaluate(weatherData, soilData, options);
        (r.suitable ? suitable : rejected).push({ crop, failures: r.failures, warnings: r.warnings });
    }
    return {
        totalSuitable: suitable.length,
        suitableCrops: suitable.map(s => s.crop),
        warningsById: Object.fromEntries(suitable.map(s => [s.crop.id, s.warnings])),
        rejected
    };
}

// All orderings of `size` crops, counting a cycle and its rotations as one (the cycle repeats).
function cyclicSequences(list, size) {
    const res = [];
    const rec = chosen => {
        if (chosen.length === size) { res.push(chosen.map(i => list[i])); return; }
        for (let i = 0; i < list.length; i++) {
            if (chosen.includes(i)) continue;
            if (chosen.length && i < chosen[0]) continue;   // first crop has the lowest index
            rec([...chosen, i]);
        }
    };
    rec([]);
    return res;
}

function buildCandidates(suitable) {
    const mains = suitable.filter(c => !COVER_IDS.has(c.id));
    const covers = suitable.filter(c => COVER_IDS.has(c.id));

    // Try a 3-year rotation first. If the suitable crops cannot make one (too few crops, or too many
    // from the same plant family), fall back to a 2-year rotation, then a single crop with cover.
    for (let size = Math.min(3, mains.length); size >= 1; size--) {
        const out = [];
        for (const years of cyclicSequences(mains, size)) {
            // no crop may directly follow its own plant family (including wrap-around)
            if (size > 1 && years.some((c, i) => familyOf(c) === familyOf(years[(i + 1) % size]))) continue;
            out.push({ years, cover: null });
            for (const cover of covers) {
                const gaps = [];
                for (let p = 0; p < size; p++)
                    if (coverFits(years[p], cover, years[(p + 1) % size])) gaps.push(p);
                if (gaps.length) out.push({ years, cover: { crop: cover, gaps } });   // cover goes in every gap that fits
            }
        }
        if (out.length) return out;
    }
    return [];   // no main crop passed the checks (only cover crops, or nothing)
}

const seqKey = seq => seq.years.map(c => c.id).sort().join("|") + (seq.cover ? "+" + seq.cover.crop.id : "");

// Turn the farmer's ticked crops (in the order they ticked them) into a rotation.
function buildExistingSeq(ids) {
    const crops = ids.map(id => CROP_DATABASE.find(c => c.id === id)).filter(Boolean);
    const mains = crops.filter(c => !COVER_IDS.has(c.id));
    const cover = crops.find(c => COVER_IDS.has(c.id));
    if (!mains.length) return null;   // only cover crops ticked: nothing to compare
    let cov = null;
    if (cover) {
        const gaps = [];
        for (let p = 0; p < mains.length; p++)
            if (coverFits(mains[p], cover, mains[(p + 1) % mains.length])) gaps.push(p);
        if (gaps.length) cov = { crop: cover, gaps };
    }
    return { years: mains, cover: cov };
}

function recommend(profile, soil, options = {}) {
    const { existingIds = [], irrigated = false, weights = null } = options;
    const evalOptions = { irrigated };
    const primaryWeights = weights || PRESETS["Balanced"];   // the existing rotation is judged on the same weights as the top pick
    const sel = selectSuitableCrops(profile, soil, evalOptions);
    const candidates = buildCandidates(sel.suitableCrops);

    // Existing rotation: same scoring, no suitability filter, so its problems show up as risks
    let baseline = null, baselineDetails = null;
    const baseSeq = buildExistingSeq(existingIds);
    if (baseSeq) {
        const f = computeFactors(baseSeq, profile, soil);
        baselineDetails = f.details;
        baseline = {
            label: "Existing rotation", seq: baseSeq, factors: f.factors,
            total: totalScore(f.factors, primaryWeights),
            ...explainRotation(baseSeq, profile, soil, evalOptions, f.details, null)
        };
    }

    // Score every candidate once, then pick the best per weight set
    const scored = candidates.map(seq => ({ seq, ...computeFactors(seq, profile, soil) }));
    const plan = weights
        ? [["Your priorities", weights], ...Object.entries(PRESETS)]
        : [["Program's pick (balanced)", PRESETS["Balanced"]],
           ...Object.entries(PRESETS).filter(([k]) => k !== "Balanced")];

    const used = new Set();
    const strategies = [];
    for (const [label, w] of plan) {
        if (strategies.length >= 3) break;
        const ranked = scored
            .map(c => ({ ...c, total: totalScore(c.factors, w) }))
            .sort((a, b) => b.total - a.total);
        const pick = ranked.find(r => !used.has(seqKey(r.seq)));
        if (!pick) continue;
        used.add(seqKey(pick.seq));
        strategies.push({
            label, weights: w, seq: pick.seq, factors: pick.factors, total: pick.total,
            ...explainRotation(pick.seq, profile, soil, evalOptions, pick.details, baselineDetails)
        });
    }

    const mainCount = sel.suitableCrops.filter(c => !COVER_IDS.has(c.id)).length;
    return { baseline, strategies, suitableCount: sel.totalSuitable, mainCount, rejected: sel.rejected, candidateCount: candidates.length };
}

// Fetch live data, build the profile, and recommend. Entry point for the UI.
async function runRecommendation(lat, lon, options = {}) {
    const [weather, soil] = await Promise.all([
        fetchNasaPowerData(lat, lon),
        fetchUsdaSoilData(lat, lon)
    ]);
    const profile = buildProfile(weather, getManualInputs());
    const result = recommend(profile, soil, options);
    return { profile, soil, ...result };
}

/* ---------------------------------------------------------------------
   7. TURN RESULTS INTO TEXT (used by both the page and the console)
   --------------------------------------------------------------------- */

function formatStrategy(s) {
    const f = s.factors;
    const lines = [];
    lines.push(`${s.label}  (score ${pct(s.total)}/100, confidence: ${s.confidence})`);
    lines.push(`  Water ${pct(f.water)} | Soil ${pct(f.soil)} | Climate ${pct(f.climate)} | Rotation order ${pct(f.rotation)} | Market ${pct(f.market)}`);
    lines.push("  The rotation (repeats after the last year):");
    describeRotation(s.seq).forEach(l => lines.push(`    ${l}`));
    lines.push("  What each crop brings:");
    s.seq.years.concat(s.seq.cover ? [s.seq.cover.crop] : []).forEach(c =>
        lines.push(`    - ${c.name} (${c.marketValue ? "approx. $" + c.marketValue.toLocaleString() + "/acre gross" : "no direct sale income"}): ${c.reason}`));
    lines.push("  Why this rotation:");
    s.reasons.forEach(r => lines.push(`    - ${r}`));
    lines.push("  Risks:");
    (s.risks.length ? s.risks : ["none flagged"]).forEach(r => lines.push(`    - ${r}`));
    lines.push("  Information gaps:");
    s.gaps.forEach(g => lines.push(`    - ${g}`));
    return lines.join("\n");
}

function formatRecommendation(result) {
    const { baseline, strategies, profile } = result;
    if (!strategies.length) {
        const why = (result.rejected || []).slice(0, 10).map(r => `  - ${r.crop.name}: ${r.failures[0]}`).join("\n");
        const lead = result.suitableCount === 0
            ? "No crop passed the climate and soil checks at this location."
            : `${result.suitableCount} crop(s) passed the checks, but only ${result.mainCount} ${result.mainCount === 1 ? "is a main crop" : "are main crops"}, and a rotation needs at least one main crop (cover crops cannot stand alone).`;
        return `No rotation could be built. ${lead}\nMain reasons crops were excluded:\n${why}\nTry the irrigation option, or check the manual inputs.`;
    }

    const out = [];
    out.push(`Recommended rotation: ${rotationTitle(strategies[0].seq)}`);
    if (baseline) out.push(`Compared with your existing rotation (${rotationTitle(baseline.seq)}), which scores ${pct(baseline.total)}/100.`);
    out.push(`Data source: ${profile.source}${result.soil ? " + USDA SSURGO" : ""}. ${result.candidateCount} possible rotations were scored.`);
    if (result.priorityNote) out.push(result.priorityNote);
    if (result.userEdits)
        out.push(result.userEdits.length ? `You confirmed the inputs after correcting: ${result.userEdits.join("; ")}.` : "You confirmed the inputs without changes.");
    strategies.forEach(s => { out.push(""); out.push(formatStrategy(s)); });
    if (baseline) { out.push(""); out.push(formatStrategy(baseline)); }
    else out.push("\nNo current crops were entered, so there is no comparison with an existing rotation.");
    out.push("");
    out.push("This tool supports your decisions. It does not replace local agronomic expertise.");
    return out.join("\n");
}

/* ---------------------------------------------------------------------
   8. PAGE WIRING
   --------------------------------------------------------------------- */

function displaySolution(cropTitle, explanationText) {
    const inputView = document.getElementById("input-view");
    const outputView = document.getElementById("output-view");
    const titleElement = document.getElementById("output-crop-title");
    const explanationElement = document.getElementById("output-explanation");

    if (inputView && outputView && titleElement && explanationElement) {
        titleElement.textContent = cropTitle;
        explanationElement.textContent = explanationText;
        explanationElement.style.whiteSpace = "pre-wrap"; // keep the line breaks and indentation
        inputView.classList.add("hidden");
        outputView.classList.remove("hidden");
        return;
    }

    // Fallback so the result is never silently lost if the output elements are missing from the HTML.
    console.warn("Output elements (input-view, output-view, output-crop-title, output-explanation) not all found; using fallback panel.");
    let box = document.getElementById("fallback-output");
    if (!box) {
        box = document.createElement("div");
        box.id = "fallback-output";
        box.style.cssText = "margin:20px;padding:16px;background:#fff;border-radius:12px;font-family:monospace;white-space:pre-wrap;";
        document.body.appendChild(box);
    }
    box.textContent = `${cropTitle}\n\n${explanationText}`;
}

const backBtn = document.getElementById("back-btn");
if (backBtn) {
    backBtn.addEventListener("click", function () {
        document.getElementById("output-view").classList.add("hidden");
        document.getElementById("input-view").classList.remove("hidden");
    });
}

// window.currentLocation is set by the Google Map below (click, drag the marker, or search).
// "Submit Location" opens the confirmation pop-up for that spot; the pop-up runs the recommendation.
const Changer = document.getElementById("changer");
if (Changer) {
    Changer.onclick = () => {
        const loc = window.currentLocation || { lat: 42.0308, lon: -93.6319 };
        openConfirmation(loc.lat, loc.lon);
    };
}

/* ---------------------------------------------------------------------
   9. CONSOLE TEST (safe to delete)
   --------------------------------------------------------------------- */

async function runApiTest(label, testLat, testLon, options = {}) {
    console.log(`\n========== ${label} (${testLat}, ${testLon}) ==========`);
    try {
        const [weather, soil] = await Promise.all([
            fetchNasaPowerData(testLat, testLon),
            fetchUsdaSoilData(testLat, testLon)
        ]);
        if (!weather) { console.warn("NASA POWER returned no data."); return; }

        console.log(`CLIMATE (avg of ${weather.yearsOfData} yrs): rain ${weather.avgAnnualRainMM} mm, ` +
            `${weather.avgHeatDaysPerYear} days >= 32C, ${weather.avgFrostDaysPerYear} frost days, ` +
            `rain varies ${weather.rainVariabilityPct}% between years`);
        console.log(`SEASONAL RAIN (mm): winter ${weather.winterRainMM}, spring ${weather.springRainMM}, ` +
            `summer ${weather.summerRainMM}, autumn ${weather.autumnRainMM}`);
        console.log("SOIL:", soil ? `${soil.soilName}; ${soil.drainageClass}; OM ${soil.organicMatterPct}%` : "none (no SSURGO data / request blocked)");

        const profile = buildProfile(weather, null);
        const out = recommend(profile, soil, options);
        console.log(`CROPS: ${out.suitableCount} suitable, ${out.rejected.length} rejected`);
        console.log(formatRecommendation({ ...out, profile, soil }));
    } catch (error) {
        console.error("API test failed:", error);
    }
}

// Auto-run is commented out so the page does not make 3 extra API calls on every load.
// Uncomment to test from the console. recommend() no longer assumes an existing rotation, so pass existingIds.
/*
(async () => {
    await runApiTest("Ames, Iowa", 42.0308, -93.6319, { existingIds: ["corn", "soybeans"] });
    await runApiTest("Lubbock, Texas (drier, hotter), rainfed", 33.5779, -101.8552, { existingIds: ["corn", "soybeans"] });
    await runApiTest("Lubbock, Texas, with irrigation", 33.5779, -101.8552, { irrigated: true, existingIds: ["corn", "soybeans"] });
})();
*/



/* ---------------------------------------------------------------------
   10. GOOGLE MAPS (click the map or drag the marker to choose the field location)
   --------------------------------------------------------------------- */

let map;
let marker;

const DEFAULT_LOCATION = { lat: 42.0308, lon: -93.6319 };   // Ames, Iowa
window.currentLocation = { ...DEFAULT_LOCATION };           // the Changer button reads this

// Remember the chosen spot so the button analyzes the same place the marker is on.
function setLocation(lat, lon) {
    window.currentLocation = { lat, lon };
}

function initMap() {
    // 1. Create the map instance
    map = new google.maps.Map(document.getElementById("map"), {
        center: { lat: DEFAULT_LOCATION.lat, lng: DEFAULT_LOCATION.lon },
        zoom: 10,
        mapTypeId: "terrain"
    });

    // 2. Draggable marker
    marker = new google.maps.Marker({
        position: { lat: DEFAULT_LOCATION.lat, lng: DEFAULT_LOCATION.lon },
        map: map,
        draggable: true,
        title: "Drag me to your farm location"
    });

    // 3. Clicking the map moves the marker, saves the location, and opens the confirmation pop-up
    map.addListener("click", (event) => {
        const lat = event.latLng.lat();
        const lon = event.latLng.lng();
        marker.setPosition({ lat, lng: lon });
        setLocation(lat, lon);
    });

    // 4. Dragging the marker saves the new location and opens the pop-up when you let go
    marker.addListener("dragend", (event) => {
        const lat = event.latLng.lat();
        const lon = event.latLng.lng();
        setLocation(lat, lon);
    });
}


/* ---------------------------------------------------------------------
   11. MANUAL LOCATION SEARCH
   --------------------------------------------------------------------- */

// Convert a typed address or coordinate pair into latitude/longitude.
async function resolveLocation(input) {

    input = input.trim();

    if (!input) {
        throw new Error("Please enter a location.");
    }

    // 1. Check whether the input is coordinates.
    // Supports:
    // 35.2271, -80.8431
    // 35.2271 -80.8431
    const coordinateMatch = input.match(
        /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/
    );

    if (coordinateMatch) {

        const lat = Number(coordinateMatch[1]);
        const lon = Number(coordinateMatch[2]);

        // Validate coordinate ranges.
        if (
            lat < -90 || lat > 90 ||
            lon < -180 || lon > 180
        ) {
            throw new Error("Invalid coordinates. Latitude must be between -90 and 90, and longitude between -180 and 180.");
        }

        return { lat, lon };
    }

    // 2. Otherwise, interpret the input as an address.
    if (!google.maps.Geocoder) {
        throw new Error("Google Maps Geocoder is unavailable.");
    }

    const geocoder = new google.maps.Geocoder();

    const response = await geocoder.geocode({
        address: input
    });

    if (!response.results || response.results.length === 0) {
        throw new Error("Could not find that location. Try a different address or coordinates.");
    }

    const location = response.results[0].geometry.location;

    return {
        lat: location.lat(),
        lon: location.lng()
    };
}


// Update the Google Map and the shared application location.
function updateMapLocation(lat, lon) {

    setLocation(lat, lon);

    if (map && marker) {

        const position = { lat, lng: lon };

        marker.setPosition(position);
        map.setCenter(position);
        map.setZoom(12);
    }
}


// Handle the location search button.
const locationSearchBtn = document.getElementById(
    "location-search-btn"
);

if (locationSearchBtn) {

    locationSearchBtn.addEventListener("click", async () => {

        const input = document.getElementById("location-input");
        const errorElement = document.getElementById("location-error");

        const searchValue = input.value;

        errorElement.textContent = "";
        locationSearchBtn.disabled = true;
        locationSearchBtn.textContent = "Searching...";

        try {

            // Convert the user's input into coordinates.
            const location = await resolveLocation(searchValue);

            const { lat, lon } = location;

            // Save coordinates and update the map.
            updateMapLocation(lat, lon);

            console.log(
                `Location found: ${lat.toFixed(4)}, ${lon.toFixed(4)}`
            );

            // Open the confirmation pop-up for the searched location.

        } catch (error) {

            console.error("Location search failed:", error);

            errorElement.textContent = error.message;

        } finally {

            locationSearchBtn.disabled = false;
            locationSearchBtn.textContent = "Search Location";

        }
    });
}

// The form has a single text box, so pressing Enter would submit it and reload the page.
// Treat Enter as a click on "Search Location" instead.
const userForm = document.getElementById("User_Information");
if (userForm) {
    userForm.addEventListener("submit", (e) => {
        e.preventDefault();
        if (locationSearchBtn) locationSearchBtn.click();
    });
}


/* ---------------------------------------------------------------------
   12. CONFIRMATION POP-UP + PRIORITIES POP-UP
   After a location is picked, show what the code found and let the farmer
   correct it (and list their current crops). Then ask for their priorities
   before any recommendation is made.
   --------------------------------------------------------------------- */

const DRAINAGE_CLASSES = [
    "Excessively drained", "Somewhat excessively drained", "Well drained",
    "Moderately well drained", "Somewhat poorly drained", "Poorly drained", "Very poorly drained"
];

let confirmToken = null;   // identifies the latest pop-up request, so a slow lookup cannot overwrite a newer one
let confirmExisting = [];  // crop ids the farmer ticked, in the order they ticked them

// Small helper for building elements safely (text is never parsed as HTML).
function el(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === "text") n.textContent = v;
        else n.setAttribute(k, v);
    }
    kids.forEach(k => { if (k) n.append(k); });
    return n;
}

function injectConfirmStyles() {
    if (document.getElementById("confirm-styles")) return;
    const st = document.createElement("style");
    st.id = "confirm-styles";
    st.textContent = `
#confirm-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px;}
#confirm-dialog{background:#fffdf5;border:3px solid rgb(19,93,19);border-radius:18px;width:100%;max-width:560px;max-height:90vh;overflow-y:auto;padding:20px 24px;color:#263238;font-family:Arial,Helvetica,sans-serif;}
#confirm-dialog h2{color:rgb(19,93,19);font-size:1.3rem;margin-bottom:10px;text-align:center;}
#confirm-dialog h3{color:#2c3e50;font-size:1rem;margin:16px 0 6px;border-bottom:1px solid #cfd8dc;padding-bottom:4px;}
.confirm-intro{line-height:1.5;margin-bottom:8px;}
.confirm-warn{background:#fff3cd;border-left:4px solid #e0a800;padding:8px 10px;margin:8px 0;line-height:1.4;}
.confirm-info{font-size:0.9rem;color:#455a64;margin:4px 0;line-height:1.4;}
.confirm-row{display:flex;flex-direction:column;gap:3px;margin:10px 0;}
.confirm-row label{font-weight:bold;font-size:0.95rem;}
.confirm-row small{color:#607d8b;}
.confirm-row input[type=number],.confirm-row select{padding:6px 8px;border:1px solid #90a4ae;border-radius:8px;font-size:1rem;background:#fff;}
.confirm-check{display:flex;align-items:center;gap:8px;margin:12px 0;}
.confirm-check small{color:#607d8b;}
.crop-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:4px 10px;max-height:170px;overflow-y:auto;border:1px solid #cfd8dc;border-radius:8px;padding:8px;background:#fff;}
.crop-opt{display:flex;align-items:center;gap:6px;font-size:0.9rem;}
#cf-error{color:#c62828;min-height:1.2em;margin-top:6px;}
.confirm-buttons{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;margin-top:12px;}
.confirm-buttons button{padding:10px 16px;border-radius:24px;border:2px solid black;font-size:1rem;cursor:pointer;}
#cf-confirm{background:rgb(46,183,80);font-weight:bold;}
#cf-cancel{background:#eceff1;}
`;
    document.head.appendChild(st);
}

function getConfirmOverlay() {
    let overlay = document.getElementById("confirm-overlay");
    if (overlay) return overlay;
    injectConfirmStyles();
    overlay = el("div", { id: "confirm-overlay" },
        el("div", { id: "confirm-dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "confirm-title" },
            el("h2", { id: "confirm-title", text: "Please double-check this information" }),
            el("div", { id: "confirm-body" })));
    overlay.style.display = "none";
    document.body.appendChild(overlay);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeConfirm(); });
    return overlay;
}

function closeConfirm() {
    confirmToken = null;
    const overlay = document.getElementById("confirm-overlay");
    if (overlay) overlay.style.display = "none";
}

// Entry point: called when the farmer picks a location (map click, marker drag, search, or Submit button).
async function openConfirmation(lat, lon) {
    const overlay = getConfirmOverlay();
    const body = document.getElementById("confirm-body");
    const token = Symbol("confirm");
    confirmToken = token;

    document.getElementById("confirm-title").textContent = "Please double-check this information";
    body.replaceChildren(el("p", { class: "confirm-intro", text: `Looking up NASA climate and USDA soil data for ${lat.toFixed(4)}, ${lon.toFixed(4)}...` }));
    overlay.style.display = "flex";

    const [weather, soil] = await Promise.all([fetchNasaPowerData(lat, lon), fetchUsdaSoilData(lat, lon)]);
    if (confirmToken !== token) return;   // the farmer picked another spot or cancelled meanwhile

    console.log("Data found for confirmation:", { lat, lon, weather, soil });
    renderConfirmation(lat, lon, weather, soil);
}

function confirmRow(id, label, input, hint) {
    return el("div", { class: "confirm-row" }, el("label", { for: id, text: label }), input, hint ? el("small", { text: hint }) : null);
}
function numberInput(id, value, min, max, step = "1") {
    const input = el("input", { id, type: "number", min: String(min), max: String(max), step });
    input.value = value == null ? "" : String(value);
    return input;
}

// Typical two-crop rotations, tried in order. The first pair where both crops pass the
// climate and soil checks (rainfed) becomes the default "current rotation" shown to the farmer.
const DEFAULT_ROTATIONS = [
    ["corn", "soybeans"],
    ["cotton", "peanuts"],
    ["winter_wheat", "sorghum"],
    ["spring_wheat", "canola"]
];

function guessExistingRotation(profile, soil) {
    for (const ids of DEFAULT_ROTATIONS) {
        const crops = ids.map(id => CROP_DATABASE.find(c => c.id === id));
        if (crops.every(c => c.isSuitableFor(profile, soil, {}))) return ids;
    }
    return ["corn", "soybeans"];
}

function renderConfirmation(lat, lon, weather, soil) {
    const body = document.getElementById("confirm-body");
    const profile = buildProfile(weather, getManualInputs());
    const live = !!weather;
    document.getElementById("confirm-title").textContent = "Please double-check this information";
    confirmExisting = [];
    body.replaceChildren();

    body.append(el("p", { class: "confirm-intro",
        text: `We looked up your field at ${lat.toFixed(4)}, ${lon.toFixed(4)}. You know your land best, so please check these values and correct anything that looks wrong.` }));
    if (!live) body.append(el("p", { class: "confirm-warn",
        text: "We could not get NASA POWER climate data for this spot. The numbers below are rough estimates from the Temperature and Humidity dropdowns on the main page. Please correct them if you can." }));

    // ---- Climate
    body.append(el("h3", { text: live ? `Climate (NASA POWER, average of ${weather.yearsOfData} years)` : "Climate (estimate)" }));
    body.append(confirmRow("cf-rain", "Average yearly rainfall (mm)", numberInput("cf-rain", profile.avgAnnualRainMM, 0, 6000),
        live ? `Varies about ${weather.rainVariabilityPct}% from year to year.` : null));
    body.append(confirmRow("cf-heat", "Days per year at 32°C (90°F) or above", numberInput("cf-heat", profile.avgHeatDaysPerYear, 0, 366)));
    body.append(confirmRow("cf-frost", "Frost days per year (low of 0°C / 32°F or below)", numberInput("cf-frost", profile.avgFrostDaysPerYear, 0, 366)));
    if (live) {
        body.append(el("p", { class: "confirm-info",
            text: `Rain by season (mm): winter ${weather.winterRainMM}, spring ${weather.springRainMM}, summer ${weather.summerRainMM}, autumn ${weather.autumnRainMM}. If you change yearly rainfall, these are scaled to match.` }));
        body.append(el("p", { class: "confirm-info",
            text: `Root-zone wetness: ${weather.avgRootZoneWetness} (0 is bone dry, 1 is saturated).` }));
    }

    // ---- Soil
    body.append(el("h3", { text: "Soil (USDA SSURGO)" }));
    if (soil) body.append(el("p", { class: "confirm-info", text: `Soil type found: ${soil.soilName}` }));
    else body.append(el("p", { class: "confirm-warn",
        text: "No USDA soil data was found for this spot (it may be outside the U.S.). If you know your soil, enter it below. Otherwise leave these blank." }));

    const drainSelect = el("select", { id: "cf-drainage" });
    const known = soil?.drainageClass || "";
    const options = [""].concat(DRAINAGE_CLASSES);
    if (known && !DRAINAGE_CLASSES.includes(known)) options.push(known);
    options.forEach(v => drainSelect.append(el("option", { value: v, text: v || "Not sure" })));
    drainSelect.value = known;
    body.append(confirmRow("cf-drainage", "Soil drainage", drainSelect, "How quickly water leaves the field after heavy rain."));

    const omValue = soil && soil.organicMatterPct != null && !isNaN(Number(soil.organicMatterPct)) ? Number(soil.organicMatterPct) : null;
    body.append(confirmRow("cf-om", "Organic matter (%)", numberInput("cf-om", omValue, 0, 100, "0.1"), "Leave blank if you do not know."));

    // ---- Farm options
    body.append(el("h3", { text: "Your farm" }));
    const nameOf = id => CROP_DATABASE.find(x => x.id === id).name;
    const guess = guessExistingRotation(profile, soil);
    confirmExisting = [...guess];

    body.append(el("p", { class: "confirm-info",
        text: `We assumed your current rotation is: ${guess.map(nameOf).join(" → ")}. This is a typical rotation for your climate and soil, not something we detected on your field. Is that correct?` }));
    const yes = el("input", { id: "cf-rot-yes", type: "radio", name: "cf-rot" });
    const no = el("input", { id: "cf-rot-no", type: "radio", name: "cf-rot" });
    yes.checked = true;
    body.append(
        el("div", { class: "confirm-check" }, yes, el("label", { for: "cf-rot-yes", text: "Yes, that is my rotation" })),
        el("div", { class: "confirm-check" }, no, el("label", { for: "cf-rot-no", text: "No, let me change it" })));

    const editHint = el("p", { class: "confirm-info",
        text: "Tick the crops you grow now, in the order you rotate them. Clear every box if you do not have a rotation to compare." });
    const orderNote = el("p", { class: "confirm-info" });
    const grid = el("div", { id: "cf-crops", class: "crop-grid" });
    const cropBoxes = {};
    const refreshOrder = () => {
        orderNote.textContent = confirmExisting.length
            ? "Current rotation: " + confirmExisting.map(nameOf).join(" → ")
            : "Current rotation: none selected";
    };
    CROP_DATABASE.forEach(c => {
        const cb = el("input", { type: "checkbox", id: `cf-crop-${c.id}`, value: c.id });
        cb.checked = guess.includes(c.id);
        cropBoxes[c.id] = cb;
        cb.addEventListener("change", () => {
            if (cb.checked) confirmExisting.push(c.id);
            else confirmExisting = confirmExisting.filter(id => id !== c.id);
            refreshOrder();
        });
        grid.append(el("label", { class: "crop-opt" }, cb, document.createTextNode(c.name)));
    });
    const showEditor = show => {
        editHint.style.display = show ? "" : "none";
        grid.style.display = show ? "" : "none";
        orderNote.style.display = show ? "" : "none";
    };
    showEditor(false);
    refreshOrder();
    yes.addEventListener("change", () => {
        if (!yes.checked) return;
        confirmExisting = [...guess];                                   // back to the program's guess
        Object.entries(cropBoxes).forEach(([id, b]) => { b.checked = guess.includes(id); });
        refreshOrder();
        showEditor(false);
    });
    no.addEventListener("change", () => { if (no.checked) showEditor(true); });
    body.append(editHint, grid, orderNote);

    const irrig = el("input", { id: "cf-irrigation", type: "checkbox" });
    body.append(el("div", { class: "confirm-check" }, irrig,
        el("label", { for: "cf-irrigation", text: "I can irrigate my fields (a rain shortfall becomes a warning instead of ruling a crop out)" })));

    body.append(el("p", { id: "cf-error" }));
    const confirmBtn = el("button", { id: "cf-confirm", type: "button", text: "Yes, this looks right. Continue" });
    const cancelBtn = el("button", { id: "cf-cancel", type: "button", text: "Cancel" });
    body.append(el("div", { class: "confirm-buttons" }, cancelBtn, confirmBtn));

    cancelBtn.addEventListener("click", closeConfirm);
    confirmBtn.addEventListener("click", () => {
        const v = readConfirmValues();
        if (v.error) { document.getElementById("cf-error").textContent = v.error; return; }
        const { profile: p, soil: s, edits } = applyConfirmedValues(profile, soil, v);
        // Don't close the overlay: swap its content for the priorities pop-up
        renderPriorities(p, s, { irrigated: v.irrigated, existingIds: v.existingIds }, edits);
    });
    if (confirmBtn.focus) confirmBtn.focus();
}

// Read and validate what the farmer left in the form.
function readConfirmValues() {
    const num = (id, label, min, max, allowBlank = false) => {
        const raw = document.getElementById(id).value;
        if (raw === "" || raw == null) return allowBlank ? { value: null } : { error: `Please enter ${label}.` };
        const n = Number(raw);
        if (isNaN(n) || n < min || n > max) return { error: `${label[0].toUpperCase()}${label.slice(1)} must be between ${min} and ${max}.` };
        return { value: n };
    };
    const rain = num("cf-rain", "yearly rainfall", 0, 6000);
    const heat = num("cf-heat", "the number of hot days", 0, 366);
    const frost = num("cf-frost", "the number of frost days", 0, 366);
    const om = num("cf-om", "organic matter", 0, 100, true);
    for (const r of [rain, heat, frost, om]) if (r.error) return { error: r.error };
    return {
        rain: rain.value, heat: heat.value, frost: frost.value, om: om.value,
        drainage: document.getElementById("cf-drainage").value,
        irrigated: !!document.getElementById("cf-irrigation").checked,
        existingIds: [...confirmExisting]
    };
}

// Apply the farmer's corrections to copies of the fetched data, and list what changed.
function applyConfirmedValues(profile, soil, v) {
    const p = { ...profile };
    const edits = [];

    if (v.rain !== profile.avgAnnualRainMM) {
        const old = profile.avgAnnualRainMM;
        const f = old > 0 ? v.rain / old : 1;
        if (profile.avgMonthlyRainMM)
            p.avgMonthlyRainMM = old > 0 ? profile.avgMonthlyRainMM.map(x => Math.round(x * f)) : Array(12).fill(Math.round(v.rain / 12));
        if (profile.yearlyRainMM)
            p.yearlyRainMM = Object.fromEntries(Object.entries(profile.yearlyRainMM).map(([y, x]) => [y, Math.round(x * f)]));
        p.avgAnnualRainMM = v.rain;
        edits.push(`yearly rain ${old} → ${v.rain} mm`);
    }

    if (v.heat !== profile.avgHeatDaysPerYear) {
        if (profile.avgMonthlyHeatDays) {
            const total = profile.avgMonthlyHeatDays.reduce((a, b) => a + b, 0);
            p.avgMonthlyHeatDays = total > 0
                ? profile.avgMonthlyHeatDays.map(x => +(x * v.heat / total).toFixed(1))
                : profile.avgMonthlyHeatDays.map((x, i) => [5, 6, 7].includes(i) ? +(v.heat / 3).toFixed(1) : 0);   // no heat before: put it in Jun-Aug
        }
        edits.push(`hot days ${profile.avgHeatDaysPerYear} → ${v.heat} per year`);
        p.avgHeatDaysPerYear = v.heat;
    }

    if (v.frost !== profile.avgFrostDaysPerYear) {
        edits.push(`frost days ${profile.avgFrostDaysPerYear} → ${v.frost} per year`);
        p.avgFrostDaysPerYear = v.frost;
    }

    let s = soil ? { ...soil } : null;
    const blankSoil = () => ({ soilName: "entered by you", drainageClass: null, organicMatterPct: null, sandPct: null, clayPct: null });

    const oldDrain = soil?.drainageClass || "";
    if (v.drainage !== oldDrain) {
        s = s || blankSoil();
        s.drainageClass = v.drainage || null;
        edits.push(`soil drainage ${oldDrain || "unknown"} → ${v.drainage || "unknown"}`);
    }

    const oldOm = soil && soil.organicMatterPct != null && !isNaN(Number(soil.organicMatterPct)) ? Number(soil.organicMatterPct) : null;
    if (v.om !== oldOm) {
        s = s || blankSoil();
        s.organicMatterPct = v.om;
        edits.push(`organic matter ${oldOm ?? "unknown"} → ${v.om ?? "unknown"}%`);
    }

    return { profile: p, soil: s, edits };
}

// ---- Priorities pop-up (second step, shown after the confirmation) ----
const PRIORITY_OPTIONS = [
    { key: "market",   label: "Market value / income",           hint: "favor crops with higher estimated revenue per acre" },
    { key: "water",    label: "Water conservation",              hint: "favor low-water crops that fit your rainfall" },
    { key: "soil",     label: "Soil health & erosion control",   hint: "less bare ground, more cover and erosion-control crops" },
    { key: "climate",  label: "Heat & frost resilience",         hint: "crops with the most headroom against local extremes" },
    { key: "rotation", label: "Natural fertility & pest breaks", hint: "nitrogen fixers before heavy feeders, more plant-family variety" }
];

function renderPriorities(profile, soil, options, edits) {
    const body = document.getElementById("confirm-body");
    document.getElementById("confirm-title").textContent = "What matters most to you?";
    body.replaceChildren();
    body.append(el("p", { class: "confirm-intro",
        text: "Tick everything that matters to you. We will weight those goals more heavily when suggesting rotations." }));

    const boxes = {};
    PRIORITY_OPTIONS.forEach(o => {
        const cb = el("input", { id: `pr-${o.key}`, type: "checkbox" });
        boxes[o.key] = cb;
        body.append(el("div", { class: "confirm-check" }, cb,
            el("label", { for: `pr-${o.key}` }, el("strong", { text: o.label }), el("small", { text: ` (${o.hint})` }))));
    });

    const none = el("input", { id: "pr-none", type: "checkbox" });
    body.append(el("h3", { text: "Or" }));
    body.append(el("div", { class: "confirm-check" }, none,
        el("label", { for: "pr-none" }, el("strong", { text: "No preference: let the program decide" }))));

    // "No preference" and the specific priorities exclude each other
    none.addEventListener("change", () => { if (none.checked) Object.values(boxes).forEach(b => { b.checked = false; }); });
    Object.values(boxes).forEach(b => b.addEventListener("change", () => { if (b.checked) none.checked = false; }));

    body.append(el("p", { id: "cf-error" }));
    const goBtn = el("button", { id: "cf-confirm", type: "button", text: "Get my recommendation" });
    const cancelBtn = el("button", { id: "cf-cancel", type: "button", text: "Cancel" });
    body.append(el("div", { class: "confirm-buttons" }, cancelBtn, goBtn));

    cancelBtn.addEventListener("click", closeConfirm);
    goBtn.addEventListener("click", () => {
        const chosen = PRIORITY_OPTIONS.filter(o => boxes[o.key].checked);
        if (!none.checked && !chosen.length) {
            document.getElementById("cf-error").textContent = "Pick at least one priority, or choose \"No preference\".";
            return;
        }
        let weights = null, priorityNote;
        if (chosen.length) {
            weights = { water: 1, soil: 1, climate: 1, rotation: 1, market: 1 };
            chosen.forEach(o => { weights[o.key] = 3; });
            priorityNote = `Your priorities: ${chosen.map(o => o.label).join(", ")}.`;
        } else {
            priorityNote = "No preferences were set, so the program weighed all factors equally and chose for you.";
        }
        closeConfirm();
        showRecommendation(profile, soil, { ...options, weights, priorityNote }, edits);
    });
}

// Run the recommendation on the confirmed data and show it.
function showRecommendation(profile, soil, options, edits) {
    try {
        const result = { profile, soil, ...recommend(profile, soil, options), userEdits: edits, priorityNote: options.priorityNote };
        const text = formatRecommendation(result);
        console.log(text);
        const top = result.strategies[0];
        displaySolution(top ? rotationTitle(top.seq) : "No rotation found", text);
    } catch (err) {
        console.error(err);
        displaySolution("Something went wrong", "Could not build a recommendation. Check the console for details.");
    }
}

// Enter key in the location box: run the same search as the button.
const locationInput = document.getElementById("location-input");

if (locationInput) {
    locationInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            if (locationSearchBtn) locationSearchBtn.click();
        }
    });
}