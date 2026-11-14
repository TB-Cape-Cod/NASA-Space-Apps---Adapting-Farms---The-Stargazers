async function fetchNasaPowerData(lat, lon) {
    // Includes T2M_MAX/MIN (temp), PRECTOTCORR (rain), and GWETROOT (root-zone soil moisture)
    const url = `https://power.larc.nasa.gov/api/temporal/daily/point?parameters=T2M_MAX,T2M_MIN,PRECTOTCORR,GWETROOT&community=AG&longitude=${lon}&latitude=${lat}&start=20210101&end=20251231&format=JSON`;

    const response = await fetch(url);
    const data = await response.json();

    const maxT = data.properties.parameter.T2M_MAX;
    const minT = data.properties.parameter.T2M_MIN;
    const rain = data.properties.parameter.PRECTOTCORR;
    const soilMoisture = data.properties.parameter.GWETROOT; // 0 = bone dry, 1 = saturated

    let totalRain = 0, frostDays = 0, heatDays = 0, moistureSum = 0, validDays = 0;

    for (const date in rain) {
        if (rain[date] === -999 || soilMoisture[date] === -999) continue;

        totalRain += rain[date];
        moistureSum += soilMoisture[date];
        if (minT[date] <= 0) frostDays++;
        if (maxT[date] >= 32) heatDays++;
        validDays++;
    }

    return {
        avgAnnualRainMM: Math.round(totalRain / 5),
        avgFrostDaysPerYear: Math.round(frostDays / 5),
        avgHeatDaysPerYear: Math.round(heatDays / 5),
        avgRootZoneWetness: +(moistureSum / validDays).toFixed(2) // e.g., 0.58 (58% wetness)
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

    console.log("Testing NASA POWER & USDA SSURGO APIs...");

    try {
        const [weatherData, soilData] = await Promise.all([
            fetchNasaPowerData(testLat, testLon),
            fetchUsdaSoilData(testLat, testLon)
        ]);

        console.log("✅ NASA POWER Result:", weatherData);
        console.log("✅ USDA SSURGO Soil Result:", soilData);

        const sampleTileUrl = getNasaGibsTileUrl("smapMoisture", 6, 23, 15);
        console.log("✅ NASA GIBS Tile URL (click to view image):", sampleTileUrl);
    } catch (error) {
        console.error("❌ API Test Failed:", error);
    }
}

runApiTest();





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