async function fetchNasaPowerData(lat, lon) {
    const url = `https://power.larc.nasa.gov/api/temporal/daily/point?parameters=T2M_MAX,T2M_MIN,PRECTOTCORR,GWETROOT&community=AG&longitude=${lon}&latitude=${lat}&start=20210101&end=20251231&format=JSON`;

    const response = await fetch(url);
    const data = await response.json();

    const maxT = data.properties.parameter.T2M_MAX;
    const minT = data.properties.parameter.T2M_MIN;
    const rain = data.properties.parameter.PRECTOTCORR;
    const soilMoisture = data.properties.parameter.GWETROOT;

    let totalRain = 0, frostDays = 0, heatDays = 0, moistureSum = 0, validDays = 0;
    const monthlyRain = Array(12).fill(0);
    const monthlyWetSum = Array(12).fill(0);
    const monthlyWetN = Array(12).fill(0);
    const yearlyRain = {};   // { 2021: mm, 2022: mm, ... }
    const yearlyWetSum = {}, yearlyWetN = {};

    for (const date in rain) {
        if (rain[date] === -999 || soilMoisture[date] === -999) continue;

        const year = date.slice(0, 4);
        const month = +date.slice(4, 6) - 1;   // 0 = January

        totalRain += rain[date];
        moistureSum += soilMoisture[date];
        if (minT[date] <= 0) frostDays++;
        if (maxT[date] >= 32) heatDays++;
        validDays++;

        monthlyRain[month] += rain[date];
        monthlyWetSum[month] += soilMoisture[date];
        monthlyWetN[month]++;
        yearlyRain[year] = (yearlyRain[year] || 0) + rain[date];
        yearlyWetSum[year] = (yearlyWetSum[year] || 0) + soilMoisture[date];
        yearlyWetN[year] = (yearlyWetN[year] || 0) + 1;
    }

    const years = Object.keys(yearlyRain);
    const nYears = years.length || 1;                       // no more hard-coded "5"
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
        avgRootZoneWetness: +(moistureSum / validDays).toFixed(2),

        // seasonal rain (growing windows overlap in June on purpose)
        avgMonthlyRainMM: r,
        springRainMM: r[3] + r[4] + r[5],                    // Apr-Jun
        summerRainMM: r[5] + r[6] + r[7],                    // Jun-Aug
        winterRainMM: r[10] + r[11] + r[0] + r[1],           // Nov-Feb

        // seasonal root-zone wetness (0-1)
        avgMonthlyWetness: w,
        springWetness: avgOf(w, [3, 4, 5]),
        summerWetness: avgOf(w, [5, 6, 7]),
        winterWetness: avgOf(w, [10, 11, 0, 1]),

        // year-to-year variability
        yearlyRainMM: Object.fromEntries(years.map(y => [y, Math.round(yearlyRain[y])])),
        yearlyWetness: Object.fromEntries(years.map(y => [y, +(yearlyWetSum[y] / yearlyWetN[y]).toFixed(2)])),
        rainVariabilityPct: Math.round((sd / mean) * 100),
        yearsOfData: nYears
    };
}

async function fetchUsdaSoilData(lat, lon) {
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

    // If outside the U.S. or no soil data found, return null for fallback handling
    if (!data.Table || data.Table.length < 2) return null;

    const [soilName, drainage, organicMatter, sand, clay] = data.Table[1];
    return {
        soilName,
        drainageClass: drainage,          // e.g., "Well drained" or "Poorly drained"
        organicMatterPct: organicMatter,  // e.g., 2.4 (%)
        sandPct: sand,
        clayPct: clay
    };
}

// Generates standard XYZ tile URLs you can pass into any map overlay
function getNasaGibsTileUrl(layerType, z, y, x) {
    // Choose between SMAP Soil Moisture or MODIS Vegetation Greenness (NDVI)
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






async function runApiTest() {
    // Sample farm coordinate in Ames, Iowa
    const testLat = 42.0308;
    const testLon = -93.6319;
    const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

    console.log("Testing NASA POWER & USDA SSURGO APIs...");

    try {
        const [weather, soil] = await Promise.all([
            fetchNasaPowerData(testLat, testLon),
            fetchUsdaSoilData(testLat, testLon)
        ]);

        console.log(`✅ Annual (avg of ${weather.yearsOfData} years):`, {
            rainMM: weather.avgAnnualRainMM,
            frostDays: weather.avgFrostDaysPerYear,
            heatDays: weather.avgHeatDaysPerYear,
            rootZoneWetness: weather.avgRootZoneWetness
        });

        console.log("✅ Seasonal rain (mm):", {
            winter: weather.winterRainMM,
            spring: weather.springRainMM,
            summer: weather.summerRainMM
        });
        console.log("✅ Seasonal root-zone wetness (0-1):", {
            winter: weather.winterWetness,
            spring: weather.springWetness,
            summer: weather.summerWetness
        });

        console.table(MONTHS.map((m, i) => ({
            month: m,
            rainMM: weather.avgMonthlyRainMM[i],
            wetness: weather.avgMonthlyWetness[i]
        })));

        console.log(`✅ Year-to-year (rain varies by ${weather.rainVariabilityPct}%):`);
        console.table(Object.keys(weather.yearlyRainMM).map(y => ({
            year: y,
            rainMM: weather.yearlyRainMM[y],
            wetness: weather.yearlyWetness[y]
        })));

        console.log("✅ USDA SSURGO Soil Result:", soil);
    } catch (error) {
        console.error("❌ API Test Failed:", error);
    }
}

runApiTest();


class Crop {
    constructor({
        id,
        name,
        category,
        minRainMM,
        maxHeatDays,
        maxFrostDays,
        needsWellDrained,
        waterUse,
        fixesNitrogen,
        erosionControl,
        reason
    }) {
        this.id = id;
        this.name = name;
        this.category = category;
        this.minRainMM = minRainMM;
        this.maxHeatDays = maxHeatDays;
        this.maxFrostDays = maxFrostDays;
        this.needsWellDrained = needsWellDrained;
        this.waterUse = waterUse;
        this.fixesNitrogen = fixesNitrogen;
        this.erosionControl = erosionControl;
        this.reason = reason;
    }

    // Built-in helper method to check if this crop survives a given farm's conditions
    isSuitableFor(weatherData, soilData) {
        if (weatherData.avgAnnualRainMM < this.minRainMM) return false;
        if (weatherData.avgHeatDaysPerYear > this.maxHeatDays + 15) return false;
        if (weatherData.avgFrostDaysPerYear > this.maxFrostDays + 15) return false;

        if (soilData && this.needsWellDrained && soilData.drainageClass && soilData.drainageClass.includes("Poorly")) {
            return false;
        }

        return true;
    }
}

// Curated from FAO GAEZ v4 Crop Profiles & USDA NRCS Cover Crop Chart (28 Crops)
const CROP_DATABASE = [
    // --- MAJOR ROW & GRAIN CASH CROPS ---
    new Crop({
        id: "corn",
        name: "Field Corn (Maize)",
        category: "High-Yield Cash Grain",
        minRainMM: 550,
        maxHeatDays: 45,
        maxFrostDays: 165,
        needsWellDrained: true,
        waterUse: "High",
        fixesNitrogen: false,
        erosionControl: "Low",
        reason: "High market demand and caloric yield, but requires heavy nitrogen and ample mid-summer moisture."
    }),
    new Crop({
        id: "soybeans",
        name: "Soybeans",
        category: "Nitrogen-Fixing Cash Crop",
        minRainMM: 500,
        maxHeatDays: 45,
        maxFrostDays: 165,
        needsWellDrained: false,
        waterUse: "Medium",
        fixesNitrogen: true,
        erosionControl: "Low",
        reason: "Fixes atmospheric nitrogen in the soil, cutting fertilizer costs for the following grain crop."
    }),
    new Crop({
        id: "winter_wheat",
        name: "Winter Wheat",
        category: "Cool-Season Cash Grain",
        minRainMM: 350,
        maxHeatDays: 55,
        maxFrostDays: 190,
        needsWellDrained: true,
        waterUse: "Low",
        fixesNitrogen: false,
        erosionControl: "High",
        reason: "Protects bare soil over winter, breaks summer pest cycles, and matures before peak July heat."
    }),
    new Crop({
        id: "spring_wheat",
        name: "Spring Wheat",
        category: "Northern Cash Grain",
        minRainMM: 320,
        maxHeatDays: 35,
        maxFrostDays: 210,
        needsWellDrained: true,
        waterUse: "Low",
        fixesNitrogen: false,
        erosionControl: "Medium",
        reason: "Well-suited to northern climates with severe winters where fall-planted wheat risks winterkill."
    }),
    new Crop({
        id: "sorghum",
        name: "Grain Sorghum (Milo)",
        category: "Drought-Tolerant Cash Grain",
        minRainMM: 380,
        maxHeatDays: 70,
        maxFrostDays: 160,
        needsWellDrained: false,
        waterUse: "Low",
        fixesNitrogen: false,
        erosionControl: "Medium",
        reason: "Uses ~30% less water than corn and goes dormant during dry spells instead of failing."
    }),
    new Crop({
        id: "barley",
        name: "Barley",
        category: "Short-Season Cash Grain",
        minRainMM: 300,
        maxHeatDays: 40,
        maxFrostDays: 205,
        needsWellDrained: true,
        waterUse: "Low",
        fixesNitrogen: false,
        erosionControl: "Medium",
        reason: "Fast-maturing cool-season grain tolerant of drought and mild soil salinity."
    }),
    new Crop({
        id: "oats",
        name: "Oats",
        category: "Cool-Season Grain / Forage",
        minRainMM: 350,
        maxHeatDays: 35,
        maxFrostDays: 200,
        needsWellDrained: false,
        waterUse: "Low",
        fixesNitrogen: false,
        erosionControl: "High",
        reason: "Thrives in cooler, wetter regions while suppressing weeds and building soil structure."
    }),
    new Crop({
        id: "triticale",
        name: "Triticale (Wheat-Rye Hybrid)",
        category: "Resilient Grain / Forage",
        minRainMM: 330,
        maxHeatDays: 50,
        maxFrostDays: 200,
        needsWellDrained: false,
        waterUse: "Low",
        fixesNitrogen: false,
        erosionControl: "High",
        reason: "Combines wheat's grain quality with rye's cold hardiness, drought tolerance, and disease resistance."
    }),

    // --- ROOT, TUBER & SPECIALTY FIELD CROPS ---
    new Crop({
        id: "potatoes",
        name: "Potatoes",
        category: "High-Value Root / Tuber Crop",
        minRainMM: 500,
        maxHeatDays: 30,
        maxFrostDays: 195,
        needsWellDrained: true,
        waterUse: "High",
        fixesNitrogen: false,
        erosionControl: "Low",
        reason: "High per-acre revenue in cool, loose, well-drained soils; requires 3–4 year rotation gaps to prevent blight."
    }),
    new Crop({
        id: "sweet_potatoes",
        name: "Sweet Potatoes",
        category: "Warm-Climate Root Crop",
        minRainMM: 500,
        maxHeatDays: 85,
        maxFrostDays: 110,
        needsWellDrained: true,
        waterUse: "Medium",
        fixesNitrogen: false,
        erosionControl: "Medium",
        reason: "Thrives in warm sandy loams with moderate water; leafy vines shade soil and suppress late-summer weeds."
    }),
    new Crop({
        id: "sugarbeets",
        name: "Sugarbeets",
        category: "Deep-Rooted Cash Crop",
        minRainMM: 450,
        maxHeatDays: 35,
        maxFrostDays: 190,
        needsWellDrained: true,
        waterUse: "Medium",
        fixesNitrogen: false,
        erosionControl: "Low",
        reason: "Deep taproot scavenges leftover nitrogen from lower soil layers and pairs well with small grains."
    }),
    new Crop({
        id: "cotton",
        name: "Upland Cotton",
        category: "Warm-Climate Fiber Crop",
        minRainMM: 500,
        maxHeatDays: 85,
        maxFrostDays: 110,
        needsWellDrained: true,
        waterUse: "Medium",
        fixesNitrogen: false,
        erosionControl: "Low",
        reason: "Heat-loving southern cash crop that benefits strongly from rotation with peanuts or winter cover crops."
    }),
    new Crop({
        id: "peanuts",
        name: "Peanuts",
        category: "Southern Nitrogen-Fixing Legume",
        minRainMM: 500,
        maxHeatDays: 85,
        maxFrostDays: 105,
        needsWellDrained: true,
        waterUse: "Medium",
        fixesNitrogen: true,
        erosionControl: "Low",
        reason: "Fixes significant soil nitrogen in warm sandy soils and disrupts cotton nematode cycles."
    }),
    new Crop({
        id: "tobacco",
        name: "Flue-Cured / Burley Tobacco",
        category: "High-Value Specialty Leaf Crop",
        minRainMM: 550,
        maxHeatDays: 75,
        maxFrostDays: 125,
        needsWellDrained: true,
        waterUse: "Medium",
        fixesNitrogen: false,
        erosionControl: "Low",
        reason: "High per-acre value in Southeast soils; strongly requires small-grain or fescue rotations to prevent soilborne diseases."
    }),
    new Crop({
        id: "rice",
        name: "Rice",
        category: "Flood-Tolerant Cash Grain",
        minRainMM: 900,
        maxHeatDays: 80,
        maxFrostDays: 115,
        needsWellDrained: false,
        waterUse: "High",
        fixesNitrogen: false,
        erosionControl: "High",
        reason: "Ideal for poorly drained heavy clay soils with abundant water where row crops would drown."
    }),
    new Crop({
        id: "industrial_hemp",
        name: "Industrial Hemp (Grain / Fiber)",
        category: "Fast-Growing Specialty Crop",
        minRainMM: 450,
        maxHeatDays: 60,
        maxFrostDays: 165,
        needsWellDrained: true,
        waterUse: "Medium",
        fixesNitrogen: false,
        erosionControl: "High",
        reason: "Deep taproot aerates compacted soils and dense canopy naturally smothers weeds without heavy herbicides."
    }),

    // --- OILSEEDS & DRY PULSES ---
    new Crop({
        id: "sunflowers",
        name: "Oilseed Sunflowers",
        category: "Deep-Rooted Drought Oilseed",
        minRainMM: 350,
        maxHeatDays: 65,
        maxFrostDays: 175,
        needsWellDrained: true,
        waterUse: "Low",
        fixesNitrogen: false,
        erosionControl: "Low",
        reason: "Taproot reaches 5+ feet deep to pull moisture and nutrients out of reach of shallow crops."
    }),
    new Crop({
        id: "canola",
        name: "Canola (Rapeseed)",
        category: "Cool-Season Oilseed",
        minRainMM: 350,
        maxHeatDays: 35,
        maxFrostDays: 200,
        needsWellDrained: true,
        waterUse: "Low",
        fixesNitrogen: false,
        erosionControl: "Medium",
        reason: "Breaks cereal disease cycles in wheat rotations and offers strong regional oilseed markets."
    }),
    new Crop({
        id: "flax",
        name: "Flaxseed",
        category: "Cool-Season Oilseed / Fiber",
        minRainMM: 320,
        maxHeatDays: 35,
        maxFrostDays: 205,
        needsWellDrained: true,
        waterUse: "Low",
        fixesNitrogen: false,
        erosionControl: "Low",
        reason: "Low-input northern rotation crop that pairs well with wheat and pulses to interrupt fungal pathogens."
    }),
    new Crop({
        id: "dry_beans",
        name: "Dry Edible Beans (Pinto / Black)",
        category: "Short-Season Nitrogen Legume",
        minRainMM: 400,
        maxHeatDays: 45,
        maxFrostDays: 175,
        needsWellDrained: true,
        waterUse: "Medium",
        fixesNitrogen: true,
        erosionControl: "Low",
        reason: "Fixes nitrogen and matures in 90–100 days, fitting well between potato or sugarbeet years."
    }),
    new Crop({
        id: "chickpeas",
        name: "Chickpeas / Lentils",
        category: "Dryland Pulse Legume",
        minRainMM: 300,
        maxHeatDays: 60,
        maxFrostDays: 180,
        needsWellDrained: true,
        waterUse: "Low",
        fixesNitrogen: true,
        erosionControl: "Low",
        reason: "Thrives in low-rainfall plains while fixing soil nitrogen and conserving moisture for winter wheat."
    }),

    // --- SOIL-BUILDING COVER & FORAGE CROPS ---
    new Crop({
        id: "clover_rye",
        name: "Crimson Clover + Cereal Rye",
        category: "Winter Cover Crop Mix",
        minRainMM: 300,
        maxHeatDays: 80,
        maxFrostDays: 195,
        needsWellDrained: false,
        waterUse: "Low",
        fixesNitrogen: true,
        erosionControl: "High",
        reason: "Stops winter rain erosion, boosts organic matter, and adds natural nitrogen before spring cash crops."
    }),
    new Crop({
        id: "hairy_vetch",
        name: "Hairy Vetch",
        category: "High-Nitrogen Winter Legume",
        minRainMM: 350,
        maxHeatDays: 70,
        maxFrostDays: 190,
        needsWellDrained: true,
        waterUse: "Low",
        fixesNitrogen: true,
        erosionControl: "High",
        reason: "Cold-hardy winter legume capable of supplying 80–120 lbs/acre of natural nitrogen to the next corn crop."
    }),
    new Crop({
        id: "oilseed_radish",
        name: "Forage / Oilseed Radish",
        category: "Compaction-Breaking Cover Crop",
        minRainMM: 350,
        maxHeatDays: 65,
        maxFrostDays: 185,
        needsWellDrained: true,
        waterUse: "Medium",
        fixesNitrogen: false,
        erosionControl: "High",
        reason: "Deep root 'biodrills' through compacted clay hardpans and winter-kills cleanly before spring planting."
    }),
    new Crop({
        id: "buckwheat",
        name: "Buckwheat",
        category: "Fast Summer Smother / Pollinator Crop",
        minRainMM: 350,
        maxHeatDays: 50,
        maxFrostDays: 180,
        needsWellDrained: false,
        waterUse: "Low",
        fixesNitrogen: false,
        erosionControl: "High",
        reason: "Matures in just 60 days to fill mid-summer bare gaps, unlock soil phosphorus, and feed pollinators."
    }),
    new Crop({
        id: "annual_ryegrass",
        name: "Annual Ryegrass",
        category: "Erosion-Control & Subsoil Cover",
        minRainMM: 400,
        maxHeatDays: 60,
        maxFrostDays: 185,
        needsWellDrained: false,
        waterUse: "Medium",
        fixesNitrogen: false,
        erosionControl: "High",
        reason: "Dense fibrous root system prevents hillside washouts and improves water infiltration in heavy soils."
    }),
    new Crop({
        id: "alfalfa",
        name: "Alfalfa",
        category: "Perennial Forage Legume",
        minRainMM: 450,
        maxHeatDays: 55,
        maxFrostDays: 185,
        needsWellDrained: true,
        waterUse: "High",
        fixesNitrogen: true,
        erosionControl: "High",
        reason: "Multi-year deep roots stabilize hillsides, fix high amounts of nitrogen, and supply livestock hay."
    }),
    new Crop({
        id: "millet",
        name: "Proso / Pearl Millet",
        category: "Emergency Dryland Grain / Forage",
        minRainMM: 280,
        maxHeatDays: 85,
        maxFrostDays: 165,
        needsWellDrained: false,
        waterUse: "Low",
        fixesNitrogen: false,
        erosionControl: "Medium",
        reason: "One of the lowest water-requirement grains available; ideal for extreme drought adaptation."
    })
];


const cropCategorySolutions = [
  // Tier 1: Wet & High-Rainfall Regimes (GPM: Wet) [Indices 0 - 9]
  "High-Biomass Warm-Season Cereals -> Nitrogen-Fixing Legumes -> Cool-Season Small Grains + Living Clover Mulch",
  "Year 1: Warm-Season Grains -> Overwintering Cereals | Year 2: Fast-Maturing Summer Legumes -> Nitrogen-Fixing Cover Crops",
  "Cool-Season Small Grains -> Cool-Season Oilseeds -> Cool-Season Nitrogen-Fixing Pulses -> Shade-Tolerant Cereals",
  "Short-Season Warm Cereals -> Heat-Tolerant Nitrogen-Fixing Legumes -> Cool-Season Forage Grains",
  "Disease-Suppressing Small Grains -> Tropical Nitrogen-Fixing Green Manures -> Drought-Hardy C4 Cereals -> Fast-Cycle Warm Grasses (4-Family Break)",
  "Hotspots: Deep-Rooted Perennial Forages | Cool Zones: High-Yield Warm-Season Cereals -> Nitrogen-Fixing Legumes",
  "Water-Tolerant Small Grains -> Flood-Tolerant Perennial Grasses & Clovers -> Deep-Taproot Compaction-Breaking Brassicas",
  "Semi-Aquatic / Flood-Tolerant Staples -> Waterlogging-Tolerant Nitrogen-Fixing Legumes -> Deep-Rooted Brassicas",
  "Salt-Tolerant Halophytic Grains -> Deep-Rooted Salt-Remediation Perennial Grasses -> Salt-Tolerant Root Crops",
  "Fast-Maturing Cold-Hardy Cereals -> Cold-Tolerant Oilseeds -> Short-Season Nitrogen-Fixing Pulses -> Perennial Legume Forages",

  // Tier 2: High-Intensity Storm Regimes (GPM: Stormy) [Indices 10 - 14]
  "No-Till High-Residue Cereals -> Nitrogen-Fixing Legumes + Dense Overwintering Fibrous-Root Cover -> Perennial Sod Grasses",
  "No-Till Tall-Stubble Small Grains -> Wind-Hardy C4 Cereals -> Heat-Tolerant Nitrogen-Fixing Legumes",
  "Flood-Tolerant Monsoon Staples -> Fast-Maturing Nitrogen-Fixing Pulses -> Short-Season Oilseeds",
  "Deep-Taproot Oilseeds -> Subsoil-Fracturing Brassicas & Biennial Legumes -> Overwintering Small Grains",
  "Overwintering Erosion-Control Grasses -> Spring Small Grains + Nitrogen-Fixing Clovers -> Dense Perennial Hay Sod",

  // Tier 3: Erratic & Bimodal Rain Regimes (GPM: Erratic) [Indices 15 - 21]
  "Cool-Season Small Grains -> Deep-Taproot Subsoil-Mining Oilseeds -> Drought-Hardy Nitrogen-Fixing Pulses",
  "Drought-Tolerant C4 Cereals -> Humidity-Adapted Nitrogen-Fixing Legumes -> Overwintering Nitrogen-Fixing & Fibrous Cover Crops",
  "No-Till Wind-Breaking Small Grains -> Ultra-Water-Efficient C4 Millets -> Deep-Rooted Biennial Nitrogen-Fixing Legumes",
  "Ultra-Fast Opportunistic C4 Grains -> Short-Cycle Arid Nitrogen-Fixing Beans -> Moisture-Banking Residue Fallow",
  "Strip-Till Drought-Hardy Cereals -> Shallow-Moisture Nitrogen-Fixing Pulses -> Standing-Stubble Windbreak Fallow",
  "Ridges: Deep-Rooted Drought Forages | Valleys: Moderate-Water C4 Cereals -> Nitrogen-Fixing Legumes",
  "Resilient Spring Small Grains -> Quick-Maturing Cool-Season Oilseeds -> Cold-Hardy Nitrogen-Fixing Pulses",

  // Tier 4: Seasonal-Shift Regimes (GPM: Seasonal) [Indices 22 - 25]
  "Winter-Active Small Grains -> Spring-Maturing Nitrogen-Fixing Pulses -> Dry-Summer Moisture-Banking Fallow",
  "High-Value Irrigated Summer Fruiting Crops -> Rainfed Winter Small Grains -> Deep-Rooted Oilseeds or Perennial Forages",
  "Deep-Rooted Perennial Tree/Row Crops + Shade Cover -> Winter Small Grains -> Deep-Taproot Heat-Tolerant Oilseeds",
  "Drought-Adapted Winter Small Grains -> Self-Reseeding Annual Nitrogen-Fixing Pasture Legumes -> Summer Fallow",

  // Tier 5: Dry & Arid Regimes (GPM: Dry) [Indices 26 - 41]
  "Ultra-Low-Water C4 Desert Grains -> Heat- & Drought-Adapted Nitrogen-Fixing Legumes -> Moisture-Banking Fallow",
  "No-Till Tall-Stubble Winter Grains -> Low-Water C4 Millets -> Multi-Season Stubble-Protected Fallow",
  "Cold-Hardy Winter Small Grains -> Cool-Season Nitrogen-Fixing Pulses -> Low-Water Oilseeds -> Moisture-Banking Fallow",
  "Frost- & UV-Tolerant High-Altitude Pseudo-Cereals -> Freeze-Hardy Tubers or Pulses -> High-Elevation Nitrogen-Fixing Legumes",
  "Deep-Rooted Winter Small Grains -> Subsoil-Mining Taproot Oilseeds -> Drought-Tolerant Nitrogen-Fixing Pulses",
  "Ephemeral / Ultra-Short-Cycle Grains -> Fast-Maturing Arid Nitrogen-Fixing Legumes -> Bare/Residue Fallow",
  "High-WUE Perennial Nitrogen-Fixing Forages -> Irrigated Fiber or Grain Crops -> Water-Saving Winter Small Grains",
  "Cool-Climate Irrigated Tubers -> Malting Small Grains -> Deep-Rooted Sugar Crops -> Nitrogen-Fixing Perennial Forages",
  "Subsurface-Irrigated Heat-Tolerant C4 Grains -> Winter Small Grains -> High-Temperature Forage Grasses",
  "Winter Small Grains -> Strip-Till Irrigated Cereals -> Nitrogen-Fixing Dry Beans + Living Windbreak Grasses",
  "Hot Rings: Heat-Hardy Perennial Sod Forages | Good Zones: Irrigated Cereals -> Winter Small Grains",
  "Salt-Tolerant Halophytic Grains -> Salt-Leaching Green Manures & Perennial Grasses -> Salt-Tolerant Fiber Crops",
  "Short-Season Mountain Small Grains -> Cold-Hardy Nitrogen-Fixing Pulses -> Drought- & Frost-Tolerant Perennial Forages",
  "Fog-Capturing Broadleaf Specialty Crops -> Coastal Small Grains -> Moisture-Condensing Cover Crops",
  "Cool-Climate Spring Small Grains -> Low-Evaporation Oilseeds -> Cool-Season Nitrogen-Fixing Pulses",
  "No-Till Residue-Retaining Winter Grains -> Water-Efficient C4 Cereals -> Heat-Tolerant Nitrogen-Fixing Cover Crops"
];

const cropCategoryReasons = [
  // Tier 1 Reasons [Indices 0 - 9]
  "Maximizes biomass and yield by pairing high-energy C4 grains with nitrogen-creating legumes and living cover where water, drainage, and canopy temperatures have no bottlenecks.",
  "Captures 100% of long subtropical growing degree days and warm humid conditions by rotating three distinct functional groups across two years.",
  "Relies on cool-season grains, oilseeds, and nitrogen-fixing pulses that thrive under low growing degree days and persistent cloud cover.",
  "Avoids peak mid-summer canopy heat crashes by pairing fast-finishing summer grains with heat-tolerant legumes and cool-season forages.",
  "Breaks residue-borne fungal pathogen and soil acidity cycles across four unrelated plant families in warm, humid, disease-prone environments.",
  "Uses 70m thermal maps to isolate sandy or compacted hot patches into deep-rooted perennial forages while keeping cool fertile zones in high-yield row crops.",
  "Pairs water-tolerant grains and flood-adapted clovers with deep compaction-breaking taproots to survive saturated lowlands and improve vertical drainage.",
  "Relies on flood-adapted staples that tolerate root-zone oxygen starvation while deep brassica taproots fracture wet compaction layers.",
  "Uses salt-tolerant halophytic grains and deep-rooted perennial grasses to lower high water tables and flush accumulated surface salts below the root zone.",
  "Fits fast-maturing, cold-hardy spring crops inside narrow northern frost-free windows to capture slow-melting snowpack moisture without winterkill.",

  // Tier 2 Reasons [Indices 10 - 14]
  "Maintains continuous living roots and dense surface residue to absorb kinetic raindrop energy and stop topsoil runoff during intense downpours.",
  "Leaves tall standing grain stubble to block drying plains winds while shielding the soil surface from violent convective cloudbursts.",
  "Capitalizes on heavy monsoon rain bursts with flood-tolerant staples followed by fast-maturing nitrogen-fixing pulses and oilseeds as soils drain.",
  "Uses aggressive taproot crops to punch through compacted hardpans so intense storm runoff can infiltrate into deep subsoil storage.",
  "Protects sloping, thawing ground from spring rain-on-snow erosion using overwintering fibrous roots and dense perennial sod.",

  // Tier 3 Reasons [Indices 15 - 21]
  "Shifts primary grain growth into cooler spring months, then deploys deep-taproot oilseeds to mine subsoil water during afternoon heat crashes.",
  "Leverages high atmospheric humidity to keep vapor pressure deficit low, enabling drought-tolerant grains and nitrogen-fixing legumes to bridge dry gaps.",
  "Combines no-till stubble windbreaks with ultra-water-efficient grains and biennial legumes to prevent hot winds from stripping scarce moisture.",
  "Avoids the 'false start' rain trap by planting ultra-fast opportunistic grains and nitrogen-fixing beans that mature on brief surface showers.",
  "Uses strip-tillage and standing crop residue to stop strong winds from flashing off shallow surface moisture after isolated rains.",
  "Splits fields by 70m thermal topography, placing drought-hardy perennial forages on shallow dry ridges and higher-water crops in moisture-collecting valleys.",
  "Pairs resilient spring grains and quick-maturing oilseeds to handle delayed northern thaws followed by unpredictable mid-summer dry spells.",

  // Tier 4 Reasons [Indices 22 - 25]
  "Completes crop growth using winter and spring rainfall before summer drought arrives, followed by summer fallow to conserve soil moisture.",
  "Balances high-value irrigated summer crops with rainfed winter small grains that utilize natural winter rainfall, cutting total irrigation demand.",
  "Manages extreme afternoon stomatal shutdown in hot irrigated valleys by pairing winter grains with deep-taproot oilseeds or shaded orchard covers.",
  "Relies on winter-annual grains and self-reseeding nitrogen-fixing pasture legumes that finish their life cycles before zero-rain summers begin.",

  // Tier 5 Reasons [Indices 26 - 41]
  "Uses short-season C4 desert grains and heat-hardy nitrogen-fixing legumes that produce on minimal water, paired with fallow periods to bank sparse rain.",
]





function displaySolution(cropTitle, explanationText) {
    const inputView = document.getElementById('input-view');
    const outputView = document.getElementById('output-view');
    
    // Target the placeholder elements in the new output layout
    const titleElement = document.getElementById('output-crop-title');
    const explanationElement = document.getElementById('output-explanation');

    // Populate with the passed arguments
    titleElement.textContent = cropTitle;
    explanationElement.textContent = explanationText;

    // Toggle views using the hidden class
    inputView.classList.add('hidden');
    outputView.classList.remove('hidden');
}


// Back button handler to return to the input form
document.getElementById('back-btn').addEventListener('click', function() {
    document.getElementById('output-view').classList.add('hidden');
    document.getElementById('input-view').classList.remove('hidden');
});

const Changer = document.getElementById("changer");
Changer.onclick = ()=> {
    displaySolution('a','b');
    console.log('work');
};
