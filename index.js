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
                  needsWellDrained, waterUse, fixesNitrogen, erosionControl, reason }) {
        Object.assign(this, { id, name, category, minRainMM, maxHeatDays, maxFrostDays,
                              needsWellDrained, waterUse, fixesNitrogen, erosionControl, reason });
        this.season = "summer"; // overwritten by SEASON_BY_ID below
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
    new Crop({ id: "corn", name: "Field Corn (Maize)", category: "High-Yield Cash Grain",
        minRainMM: 550, maxHeatDays: 45, maxFrostDays: 165, needsWellDrained: true,
        waterUse: "High", fixesNitrogen: false, erosionControl: "Low",
        reason: "High market demand and caloric yield, but requires heavy nitrogen and ample mid-summer moisture." }),
    new Crop({ id: "soybeans", name: "Soybeans", category: "Nitrogen-Fixing Cash Crop",
        minRainMM: 500, maxHeatDays: 45, maxFrostDays: 165, needsWellDrained: false,
        waterUse: "Medium", fixesNitrogen: true, erosionControl: "Low",
        reason: "Fixes atmospheric nitrogen in the soil, cutting fertilizer costs for the following grain crop." }),
    new Crop({ id: "winter_wheat", name: "Winter Wheat", category: "Cool-Season Cash Grain",
        minRainMM: 350, maxHeatDays: 55, maxFrostDays: 190, needsWellDrained: true,
        waterUse: "Low", fixesNitrogen: false, erosionControl: "High",
        reason: "Protects bare soil over winter, breaks summer pest cycles, and matures before peak July heat." }),
    new Crop({ id: "spring_wheat", name: "Spring Wheat", category: "Northern Cash Grain",
        minRainMM: 320, maxHeatDays: 35, maxFrostDays: 210, needsWellDrained: true,
        waterUse: "Low", fixesNitrogen: false, erosionControl: "Medium",
        reason: "Well-suited to northern climates with severe winters where fall-planted wheat risks winterkill." }),
    new Crop({ id: "sorghum", name: "Grain Sorghum (Milo)", category: "Drought-Tolerant Cash Grain",
        minRainMM: 380, maxHeatDays: 120, maxFrostDays: 160, needsWellDrained: false,
        waterUse: "Low", fixesNitrogen: false, erosionControl: "Medium",
        reason: "Uses ~30% less water than corn and goes dormant during dry spells instead of failing." }),
    new Crop({ id: "barley", name: "Barley", category: "Short-Season Cash Grain",
        minRainMM: 300, maxHeatDays: 40, maxFrostDays: 205, needsWellDrained: true,
        waterUse: "Low", fixesNitrogen: false, erosionControl: "Medium",
        reason: "Fast-maturing cool-season grain tolerant of drought and mild soil salinity." }),
    new Crop({ id: "oats", name: "Oats", category: "Cool-Season Grain / Forage",
        minRainMM: 350, maxHeatDays: 35, maxFrostDays: 200, needsWellDrained: false,
        waterUse: "Low", fixesNitrogen: false, erosionControl: "High",
        reason: "Thrives in cooler, wetter regions while suppressing weeds and building soil structure." }),
    new Crop({ id: "triticale", name: "Triticale (Wheat-Rye Hybrid)", category: "Resilient Grain / Forage",
        minRainMM: 330, maxHeatDays: 50, maxFrostDays: 200, needsWellDrained: false,
        waterUse: "Low", fixesNitrogen: false, erosionControl: "High",
        reason: "Combines wheat's grain quality with rye's cold hardiness, drought tolerance, and disease resistance." }),

    // --- ROOT, TUBER & SPECIALTY FIELD CROPS ---
    new Crop({ id: "potatoes", name: "Potatoes", category: "High-Value Root / Tuber Crop",
        minRainMM: 500, maxHeatDays: 30, maxFrostDays: 195, needsWellDrained: true,
        waterUse: "High", fixesNitrogen: false, erosionControl: "Low",
        reason: "High per-acre revenue in cool, loose, well-drained soils; requires 3–4 year rotation gaps to prevent blight." }),
    new Crop({ id: "sweet_potatoes", name: "Sweet Potatoes", category: "Warm-Climate Root Crop",
        minRainMM: 500, maxHeatDays: 120, maxFrostDays: 110, needsWellDrained: true,
        waterUse: "Medium", fixesNitrogen: false, erosionControl: "Medium",
        reason: "Thrives in warm sandy loams with moderate water; leafy vines shade soil and suppress late-summer weeds." }),
    new Crop({ id: "sugarbeets", name: "Sugarbeets", category: "Deep-Rooted Cash Crop",
        minRainMM: 450, maxHeatDays: 35, maxFrostDays: 190, needsWellDrained: true,
        waterUse: "Medium", fixesNitrogen: false, erosionControl: "Low",
        reason: "Deep taproot scavenges leftover nitrogen from lower soil layers and pairs well with small grains." }),
    new Crop({ id: "cotton", name: "Upland Cotton", category: "Warm-Climate Fiber Crop",
        minRainMM: 500, maxHeatDays: 130, maxFrostDays: 110, needsWellDrained: true,
        waterUse: "Medium", fixesNitrogen: false, erosionControl: "Low",
        reason: "Heat-loving southern cash crop that benefits strongly from rotation with peanuts or winter cover crops." }),
    new Crop({ id: "peanuts", name: "Peanuts", category: "Southern Nitrogen-Fixing Legume",
        minRainMM: 500, maxHeatDays: 120, maxFrostDays: 105, needsWellDrained: true,
        waterUse: "Medium", fixesNitrogen: true, erosionControl: "Low",
        reason: "Fixes significant soil nitrogen in warm sandy soils and disrupts cotton nematode cycles." }),
    new Crop({ id: "tobacco", name: "Flue-Cured / Burley Tobacco", category: "High-Value Specialty Leaf Crop",
        minRainMM: 550, maxHeatDays: 95, maxFrostDays: 125, needsWellDrained: true,
        waterUse: "Medium", fixesNitrogen: false, erosionControl: "Low",
        reason: "High per-acre value in Southeast soils; strongly requires small-grain or fescue rotations to prevent soilborne diseases." }),
    new Crop({ id: "rice", name: "Rice", category: "Flood-Tolerant Cash Grain",
        minRainMM: 900, maxHeatDays: 110, maxFrostDays: 115, needsWellDrained: false,
        waterUse: "High", fixesNitrogen: false, erosionControl: "High",
        reason: "Ideal for poorly drained heavy clay soils with abundant water where row crops would drown." }),
    // --- OILSEEDS & DRY PULSES ---
    new Crop({ id: "sunflowers", name: "Oilseed Sunflowers", category: "Deep-Rooted Drought Oilseed",
        minRainMM: 350, maxHeatDays: 100, maxFrostDays: 175, needsWellDrained: true,
        waterUse: "Low", fixesNitrogen: false, erosionControl: "Low",
        reason: "Taproot reaches 5+ feet deep to pull moisture and nutrients out of reach of shallow crops." }),
    new Crop({ id: "canola", name: "Canola (Rapeseed)", category: "Cool-Season Oilseed",
        minRainMM: 350, maxHeatDays: 35, maxFrostDays: 200, needsWellDrained: true,
        waterUse: "Low", fixesNitrogen: false, erosionControl: "Medium",
        reason: "Breaks cereal disease cycles in wheat rotations and offers strong regional oilseed markets." }),
    new Crop({ id: "flax", name: "Flaxseed", category: "Cool-Season Oilseed / Fiber",
        minRainMM: 320, maxHeatDays: 35, maxFrostDays: 205, needsWellDrained: true,
        waterUse: "Low", fixesNitrogen: false, erosionControl: "Low",
        reason: "Low-input northern rotation crop that pairs well with wheat and pulses to interrupt fungal pathogens." }),
    new Crop({ id: "dry_beans", name: "Dry Edible Beans (Pinto / Black)", category: "Short-Season Nitrogen Legume",
        minRainMM: 400, maxHeatDays: 45, maxFrostDays: 175, needsWellDrained: true,
        waterUse: "Medium", fixesNitrogen: true, erosionControl: "Low",
        reason: "Fixes nitrogen and matures in 90–100 days, fitting well between potato or sugarbeet years." }),
    new Crop({ id: "chickpeas", name: "Chickpeas / Lentils", category: "Dryland Pulse Legume",
        minRainMM: 300, maxHeatDays: 60, maxFrostDays: 180, needsWellDrained: true,
        waterUse: "Low", fixesNitrogen: true, erosionControl: "Low",
        reason: "Thrives in low-rainfall plains while fixing soil nitrogen and conserving moisture for winter wheat." }),

    // --- SOIL-BUILDING COVER & FORAGE CROPS ---
    new Crop({ id: "clover_rye", name: "Crimson Clover + Cereal Rye", category: "Winter Cover Crop Mix",
        minRainMM: 300, maxHeatDays: 80, maxFrostDays: 195, needsWellDrained: false,
        waterUse: "Low", fixesNitrogen: true, erosionControl: "High",
        reason: "Stops winter rain erosion, boosts organic matter, and adds natural nitrogen before spring cash crops." }),
    new Crop({ id: "hairy_vetch", name: "Hairy Vetch", category: "High-Nitrogen Winter Legume",
        minRainMM: 350, maxHeatDays: 70, maxFrostDays: 190, needsWellDrained: true,
        waterUse: "Low", fixesNitrogen: true, erosionControl: "High",
        reason: "Cold-hardy winter legume capable of supplying 80–120 lbs/acre of natural nitrogen to the next corn crop." }),
    new Crop({ id: "oilseed_radish", name: "Forage / Oilseed Radish", category: "Compaction-Breaking Cover Crop",
        minRainMM: 350, maxHeatDays: 65, maxFrostDays: 185, needsWellDrained: true,
        waterUse: "Medium", fixesNitrogen: false, erosionControl: "High",
        reason: "Deep root 'biodrills' through compacted clay hardpans and winter-kills cleanly before spring planting." }),
    new Crop({ id: "buckwheat", name: "Buckwheat", category: "Fast Summer Smother / Pollinator Crop",
        minRainMM: 350, maxHeatDays: 50, maxFrostDays: 180, needsWellDrained: false,
        waterUse: "Low", fixesNitrogen: false, erosionControl: "High",
        reason: "Matures in just 60 days to fill mid-summer bare gaps, unlock soil phosphorus, and feed pollinators." }),
    new Crop({ id: "annual_ryegrass", name: "Annual Ryegrass", category: "Erosion-Control & Subsoil Cover",
        minRainMM: 400, maxHeatDays: 60, maxFrostDays: 185, needsWellDrained: false,
        waterUse: "Medium", fixesNitrogen: false, erosionControl: "High",
        reason: "Dense fibrous root system prevents hillside washouts and improves water infiltration in heavy soils." }),
    new Crop({ id: "alfalfa", name: "Alfalfa", category: "Perennial Forage Legume",
        minRainMM: 450, maxHeatDays: 55, maxFrostDays: 185, needsWellDrained: true,
        waterUse: "High", fixesNitrogen: true, erosionControl: "High",
        reason: "Multi-year deep roots stabilize hillsides, fix high amounts of nitrogen, and supply livestock hay." }),
    new Crop({ id: "millet", name: "Proso / Pearl Millet", category: "Emergency Dryland Grain / Forage",
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

// A rotation: { years: [crop, crop, ...], cover: { crop, after: yearIndex } | null }.
// The cycle repeats, so the last year is followed by the first.
function describeRotation(seq) {
    return seq.years.map((c, i) => {
        let t = `Year ${i + 1}: ${c.name} (${c.season} season)`;
        if (seq.cover && seq.cover.after === i)
            t += `, then ${seq.cover.crop.name} as ${seq.cover.crop.id === "buckwheat" ? "a summer cover" : "a fall-to-spring cover"}`;
        return t;
    });
}
function rotationTitle(seq) {
    return seq.years.map(c => c.name).join(" → ") + (seq.cover ? ` (+ ${seq.cover.crop.name} cover)` : "");
}

// How much of the year is the ground bare, and how much rain lands on it?
function bareSoilStats(seq, profile) {
    const n = seq.years.length;
    let bareMonths = 0, bareRain = 0;
    for (let k = 0; k < n; k++) {
        const prevIdx = (k - 1 + n) % n;
        const covered = new Set();
        coverageMonths(seq.years[k]).same.forEach(m => covered.add(m));
        coverageMonths(seq.years[prevIdx]).carry.forEach(m => covered.add(m));
        if (seq.cover) {
            const cv = coverageMonths(seq.cover.crop);
            if (seq.cover.after === k) cv.same.forEach(m => covered.add(m));
            if (seq.cover.after === prevIdx) cv.carry.forEach(m => covered.add(m));
        }
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
    "Soil & erosion focus": { water: 1, soil: 3, climate: 1, rotation: 2 },
    "Water resilience":     { water: 3, soil: 1, climate: 1, rotation: 1 },
    "Balanced":             { water: 1, soil: 1, climate: 1, rotation: 1 }
};

function totalScore(f, w) {
    const sum = w.water + w.soil + w.climate + w.rotation;
    return (f.water * w.water + f.soil * w.soil + f.climate * w.climate + f.rotation * w.rotation) / sum;
}

// Cheap numeric part: four 0-1 factors plus the details needed to explain them.
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
        const viaCover = !!(seq.cover && seq.cover.after === pi && seq.cover.crop.fixesNitrogen);
        heavy.push({ crop: c, prev, viaCover, ok: prev.fixesNitrogen || viaCover });
    });
    const hasLegume = all.some(c => c.fixesNitrogen);
    const nSeq = heavy.length ? heavy.filter(h => h.ok).length / heavy.length : (hasLegume ? 1 : 0.6);
    const families = new Set(mains.map(familyOf));
    const diversity = families.size / m;
    const rotation = 0.5 * nSeq + 0.5 * diversity;

    return {
        factors: { water, soil: soilScore, climate, rotation },
        details: { all, wins, tightestWater, tightClimate, wetness, bare, heavy, hasLegume, families }
    };
}

// Expensive text part: reasons, risks, gaps. Only run for the rotations we actually show.
function explainRotation(seq, profile, soil, evalOptions, d, baselineDetails) {
    const reasons = [], risks = [], gaps = [];
    const mains = seq.years;

    // Order and nitrogen
    for (const h of d.heavy) {
        if (h.ok) reasons.push(`${h.crop.name} follows ${h.viaCover ? seq.cover.crop.name + " (a nitrogen-fixing cover)" : h.prev.name + ", a nitrogen fixer"}, so it starts with nitrogen already in the soil.`);
        else risks.push(`${h.crop.name} follows ${h.prev.name}, which does not fix nitrogen; expect higher fertilizer needs.`);
    }
    const legumes = d.all.filter(c => c.fixesNitrogen);
    if (legumes.length) reasons.push(`Nitrogen fixers in the rotation: ${names(legumes)}.`);
    else risks.push("No nitrogen-fixing crop in the rotation; expect higher fertilizer needs.");

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
    gaps.push("Crop thresholds and rotation rules are approximate, and market or income is not scored. A local agronomist or extension office should validate this.");

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
    const size = Math.min(3, mains.length);
    const out = [];
    if (size === 0) return out;   // only cover crops passed; cannot build a rotation
    for (const years of cyclicSequences(mains, size)) {
        // no crop may directly follow its own plant family (including wrap-around)
        if (size > 1 && years.some((c, i) => familyOf(c) === familyOf(years[(i + 1) % size]))) continue;
        out.push({ years, cover: null });
        for (const cover of covers)
            for (let p = 0; p < size; p++)
                if (coverFits(years[p], cover, years[(p + 1) % size])) out.push({ years, cover: { crop: cover, after: p } });
    }
    return out;
}

const seqKey = seq => seq.years.map(c => c.id).sort().join("|") + (seq.cover ? "+" + seq.cover.crop.id : "");

function recommend(profile, soil, options = {}) {
    const { existingIds = ["corn", "soybeans"], irrigated = false } = options;
    const evalOptions = { irrigated };
    const sel = selectSuitableCrops(profile, soil, evalOptions);
    const candidates = buildCandidates(sel.suitableCrops);

    // Existing rotation: same scoring, no suitability filter, so its problems show up as risks
    let baseline = null, baselineDetails = null;
    const existing = existingIds.map(id => CROP_DATABASE.find(c => c.id === id)).filter(Boolean);
    if (existing.length) {
        const seq = { years: existing, cover: null };
        const f = computeFactors(seq, profile, soil);
        baselineDetails = f.details;
        baseline = {
            label: "Existing rotation", seq, factors: f.factors,
            total: totalScore(f.factors, PRESETS["Balanced"]),
            ...explainRotation(seq, profile, soil, evalOptions, f.details, null)
        };
    }

    // Score every candidate once, then pick the best per preset
    const scored = candidates.map(seq => ({ seq, ...computeFactors(seq, profile, soil) }));
    const used = new Set();
    const strategies = [];
    for (const [label, weights] of Object.entries(PRESETS)) {
        const ranked = scored
            .map(c => ({ ...c, total: totalScore(c.factors, weights) }))
            .sort((a, b) => b.total - a.total);
        const pick = ranked.find(r => !used.has(seqKey(r.seq)));
        if (!pick) continue;
        used.add(seqKey(pick.seq));
        strategies.push({
            label, weights, seq: pick.seq, factors: pick.factors, total: pick.total,
            ...explainRotation(pick.seq, profile, soil, evalOptions, pick.details, baselineDetails)
        });
    }

    return { baseline, strategies, suitableCount: sel.totalSuitable, rejected: sel.rejected, candidateCount: candidates.length };
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
    lines.push(`  Water ${pct(f.water)} | Soil ${pct(f.soil)} | Climate ${pct(f.climate)} | Rotation order ${pct(f.rotation)}`);
    lines.push("  The rotation (repeats after the last year):");
    describeRotation(s.seq).forEach(l => lines.push(`    ${l}`));
    lines.push("  What each crop brings:");
    s.seq.years.concat(s.seq.cover ? [s.seq.cover.crop] : []).forEach(c => lines.push(`    - ${c.name}: ${c.reason}`));
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
        return `No rotation could be built: only ${result.suitableCount} crop(s) passed the climate and soil checks at this location.\nMain reasons crops were excluded:\n${why}\nTry the irrigation option, or check the manual inputs.`;
    }

    const out = [];
    out.push(`Recommended rotation: ${rotationTitle(strategies[0].seq)}`);
    if (baseline) out.push(`Compared with your existing rotation (${rotationTitle(baseline.seq)}), which scores ${pct(baseline.total)}/100.`);
    out.push(`Data source: ${profile.source}${result.soil ? " + USDA SSURGO" : ""}. ${result.candidateCount} possible rotations were scored.`);
    strategies.forEach(s => { out.push(""); out.push(formatStrategy(s)); });
    if (baseline) { out.push(""); out.push(formatStrategy(baseline)); }
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

// Set window.currentLocation = { lat, lon } from your Google Maps search later.
// Until then this falls back to Ames, Iowa so the button does something real.
const Changer = document.getElementById("changer");
if (Changer) {
    Changer.onclick = async () => {
        const loc = window.currentLocation || { lat: 42.0308, lon: -93.6319 };
        Changer.disabled = true;
        try {
            const result = await runRecommendation(loc.lat, loc.lon);
            const text = formatRecommendation(result);
            console.log(text);
            const top = result.strategies[0];
            displaySolution(top ? rotationTitle(top.seq) : "No rotation found", text);
        } catch (err) {
            console.error(err);
            displaySolution("Something went wrong", "Could not build a recommendation. Check the console for details.");
        } finally {
            Changer.disabled = false;
        }
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

// Run sequentially so the console output stays readable.
(async () => {
    await runApiTest("Ames, Iowa", 42.0308, -93.6319);
    await runApiTest("Lubbock, Texas (drier, hotter), rainfed", 33.5779, -101.8552);
    await runApiTest("Lubbock, Texas, with irrigation", 33.5779, -101.8552, { irrigated: true });
})();










//other important thing

let map;
let marker;

function initMap() {
    // Default coordinates: Ames, Iowa (matching your existing test code)
    const defaultLat = 42.0308;
    const defaultLon = -93.6319;

    // 1. Create the map instance
    map = new google.maps.Map(document.getElementById("map"), {
        center: { lat: defaultLat, lng: defaultLon },
        zoom: 10,
        mapTypeId: 'terrain' // Terrain view is great for farming/topography!
    });

    // 2. Add a draggable marker so users can move it around
    marker = new google.maps.Marker({
        position: { lat: defaultLat, lng: defaultLon },
        map: map,
        draggable: true,
        title: "Drag me to your farm location"
    });

    // 3. Listen for clicks on the map to move the marker and fetch data
    map.addListener("click", (event) => {
        const clickedLat = event.latLng.lat();
        const clickedLon = event.latLng.lng();
        
        marker.setPosition({ lat: clickedLat, lng: clickedLon });
        fetchDataForCoordinates(clickedLat, clickedLon);
    });

    // 4. Listen for when the user finishes dragging the marker
    marker.addListener("dragend", (event) => {
        const draggedLat = event.latLng.lat();
        const draggedLon = event.latLng.lng();
        
        fetchDataForCoordinates(draggedLat, draggedLon);
    });
}

async function fetchDataForCoordinates(lat, lon) {
    console.log(`Fetching data for Latitude: ${lat.toFixed(4)}, Longitude: ${lon.toFixed(4)}...`);

    try {
        const [weather, soil] = await Promise.all([
            fetchNasaPowerData(lat, lon),
            fetchUsdaSoilData(lat, lon)
        ]);

        console.log("✅ Weather Data Loaded:", weather);
        console.log("✅ USDA Soil Data Loaded:", soil);

        const recommendations = selectSuitableCrops(weather, soil);
        console.log(`✅ Found ${recommendations.totalSuitable} suitable crops for this location.`);
        
        // Here you can update your UI elements or DOM with the results!

    } catch (error) {
        console.error("❌ Failed to fetch location data:", error);
    }
}