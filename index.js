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





const cropRotationSolutions = [
  // Tier 1: Wet & High-Rainfall Regimes (GPM: Wet) [Indices 0 - 9]
  "Corn -> Soybean -> Winter Wheat + Red Clover",
  "Year 1: Corn -> Winter Wheat | Year 2: Double-Crop Soybean -> Clover",
  "Winter Wheat -> Rapeseed (Canola) -> Faba Bean -> Oats",
  "Early-Maturing Corn -> Soybean -> Winter Triticale",
  "Oats -> Sunn Hemp -> Grain Sorghum -> Pearl Millet (4-Year Break)",
  "Hotspots: Alfalfa / Sainfoin | Cool Zones: Corn -> Soybean",
  "Oats -> Reed Canarygrass / Alsike Clover -> Tillage Radish",
  "Paddy Rice or Taro -> Sesbania / Faba Bean -> Rapeseed",
  "Salt-Tolerant Barley -> Tall Wheatgrass / Alfalfa -> Sugar Beet",
  "Spring Barley -> Canola -> Field Pea -> Alfalfa",

  // Tier 2: High-Intensity Storm Regimes (GPM: Stormy) [Indices 10 - 14]
  "No-Till Corn -> Soybean + Cereal Rye Cover -> Perennial Grass",
  "No-Till Winter Wheat (Tall Stubble) -> Grain Sorghum -> Cowpea",
  "Rice or Maize -> Mung Bean -> Mustard / Rapeseed",
  "Sunflower -> Tillage Radish / Sweetclover -> Winter Wheat",
  "Winter Rye -> Spring Oats + Red Clover -> Timothy Hay",

  // Tier 3: Erratic & Bimodal Rain Regimes (GPM: Erratic) [Indices 15 - 21]
  "Winter Wheat -> Sunflower or Safflower -> Chickpea",
  "Grain Sorghum -> Soybean -> Crimson Clover + Winter Rye",
  "No-Till Winter Wheat -> Proso Millet -> Yellow Sweetclover",
  "Pearl Millet -> Tepary Bean or Moth Bean -> Cover Fallow",
  "Strip-Till Sorghum -> Lentil -> Standing Stubble Fallow",
  "Ridges: Barley -> Sainfoin | Valleys: Sorghum -> Soybean",
  "Spring Wheat -> Flax or Camelina -> Field Pea",

  // Tier 4: Seasonal-Shift Regimes (GPM: Seasonal) [Indices 22 - 25]
  "Winter Wheat or Barley -> Chickpea or Lentil -> Summer Fallow",
  "Processing Tomato -> Winter Wheat -> Sunflower or Alfalfa",
  "Almond/Orchard Cover OR Cotton -> Winter Barley -> Safflower",
  "Durum Wheat -> Crimson Clover / Medic Pasture -> Fallow",

  // Tier 5: Dry & Arid Regimes (GPM: Dry) [Indices 26 - 41]
  "Pearl Millet -> Cowpea or Tepary Bean -> Chemical/Cover Fallow",
  "No-Till Winter Wheat -> Proso Millet -> 14-Month Stubble Fallow",
  "Winter Wheat -> Field Pea or Lentil -> Flax -> Fallow",
  "Quinoa -> Bitter Potato or Faba Bean -> Andean Lupin (Tarwi)",
  "Winter Wheat -> Safflower -> Chickpea",
  "Short-Cycle Foxtail Millet -> Mung Bean -> Fallow",
  "Alfalfa (2 Years) -> Cotton or Corn -> Winter Barley",
  "Potato -> Malting Barley -> Sugar Beet -> Alfalfa",
  "Subsurface-Drip Sorghum -> Winter Wheat -> Sudan Grass",
  "Winter Wheat -> Strip-Till Corn -> Dry Bean + Windbreak Rye",
  "Hot Rings: Bermudagrass / Alfalfa | Good Zones: Corn -> Wheat",
  "Salt-Tolerant Barley -> Sesbania / Tall Wheatgrass -> Cotton",
  "Hulless Barley -> Field Pea -> Sainfoin Forage",
  "Artichoke / Fava Bean -> Barley -> Fog-Harvesting Cover Crop",
  "Spring Wheat -> Canola -> Lentil",
  "No-Till Winter Wheat -> Grain Sorghum -> Cowpea Cover"
];

const cropRotationReasons = [
  // Tier 1 Reasons [Indices 0 - 9]
  "Maximizes biomass and yield by converting high solar irradiance into grain where water, drainage, and canopy temperatures have no bottlenecks.",
  "Captures 100% of long subtropical growing degree days and warm humid conditions by harvesting three cash crops across two years.",
  "Uses cool-season grains, oilseeds, and legumes that thrive in maritime climates with low growing degree days and persistent cloud cover.",
  "Avoids peak mid-summer canopy heat crashes by pairing early-maturing summer hybrids with cool-season triticale.",
  "Breaks residue-borne fungal pathogen and soil acidity cycles over four distinct plant families in warm, humid, disease-prone environments.",
  "Uses ECOSTRESS 70m thermal maps to isolate sandy or compacted hot patches into deep-rooted perennials while keeping cool fertile zones in high-yield row crops.",
  "Pairs water-tolerant cool-season grasses and clovers with deep tillage radishes to survive saturated lowlands and improve vertical drainage.",
  "Relies on flood-tolerant crops that thrive under root-zone anoxia while deep brassica taproots fracture wet compaction layers.",
  "Uses salt-tolerant barley and deep-rooted perennial grasses to lower high water tables and flush accumulated surface salts below the root zone.",
  "Fits fast-maturing, cold-hardy spring crops inside narrow northern frost-free windows to capture slow-melting snowpack moisture without winterkill.",

  // Tier 2 Reasons [Indices 10 - 14]
  "Maintains continuous living roots and dense surface residue to absorb kinetic raindrop energy and stop topsoil runoff during intense tropical downpours.",
  "Leaves tall standing wheat stubble to block drying plains winds while protecting the soil surface from violent convective cloudbursts.",
  "Capitalizes on heavy monsoon rain bursts with water-loving staples followed by fast-maturing pulses and oilseeds as soils drain.",
  "Uses deep taproots from sunflowers, radishes, and sweetclover to punch through compacted hardpans so storm runoff can infiltrate the subsoil.",
  "Protects sloping, thawing ground from spring rain-on-snow erosion using overwintering rye roots and dense perennial sod.",

  // Tier 3 Reasons [Indices 15 - 21]
  "Shifts primary grain growth into cooler spring months with winter wheat, then uses deep-taproot oilseeds to mine subsoil water during afternoon heat crashes.",
  "Leverages high atmospheric humidity to keep vapor pressure deficit low, enabling sorghum and soybeans to bridge multi-week dry gaps.",
  "Combines no-till stubble windbreaks with ultra-water-efficient millet and sweetclover to prevent hot winds from stripping scarce moisture.",
  "Avoids the 'false start' rain trap by planting ultra-fast desert grains and beans that mature on brief surface showers over dry subsoils.",
  "Uses strip-tillage and standing crop residue to stop strong winds from flashing off shallow surface moisture after isolated rains.",
  "Splits fields by 70m thermal topography, placing drought-hardy forage on shallow dry ridges and higher-water crops in moisture-collecting valleys.",
  "Pairs resilient spring cereals and oilseeds to handle delayed northern thaws followed by unpredictable mid-summer dry spells.",

  // Tier 4 Reasons [Indices 22 - 25]
  "Completes crop growth using winter and spring rainfall before summer drought arrives, followed by summer fallow to conserve moisture.",
  "Balances high-value summer irrigated crops with winter wheat that utilizes natural winter rainfall, reducing total annual irrigation demand.",
  "Manages extreme afternoon stomatal shutdown in hot irrigated valleys by pairing winter grains with deep-rooted safflower or orchard floor covers.",
  "Relies on winter-annual durum wheat and self-reseeding Mediterranean legumes that finish their life cycles before zero-rain summers begin.",

  // Tier 5 Reasons [Indices 26 - 41]
  "Uses short-season C4 desert grains and heat-hardy legumes that produce on minimal water, paired with fallow periods to bank sparse rainfall.",
  "Leaves 12 to 18 inches of standing wheat stubble to cut surface wind speed by up to 70% and bank 14 months of moisture across two seasons.",
  "Takes advantage of cool temperatures and low evaporation to preserve scarce steppe moisture for winter wheat, pulses, and flax.",
  "Uses frost-hardy, UV-adapted Andean heritage crops engineered for intense high-altitude solar radiation paired with freezing nights.",
  "Mines deep silt-loam winter moisture reserves using tap-rooted safflower and winter wheat despite arid surface air.",
  "Matches brief, infrequent desert rain showers with ultra-short-cycle millets and mung beans that mature before surface moisture evaporates.",
  "Maximizes water-use efficiency under desert irrigation where mild winds allow high biomass return per drop of water applied.",
  "Takes advantage of cool nights and moderate winds in irrigated northern basins to achieve high tuber, grain, and root yields with low evaporative waste.",
  "Uses subsurface drip irrigation and heat-tolerant C4 grasses to prevent extreme afternoon heat from shutting down canopy transpiration.",
  "Combines strip-till residue and rye windbreaks to shield irrigated canopies from hot, dry advective winds.",
  "Uses 70m ECOSTRESS maps to transition sandy, overheating center-pivot rings into hardy perennial forage while keeping good zones in grain.",
  "Reclaims over-irrigated, salinized desert fields using salt-tolerant barley and deep-rooted sesbania to restore drainage and leach salts.",
  "Fits short-season hulless barley and cold-tolerant sainfoin into high-elevation mountain valleys with brief frost-free windows and dry air.",
  "Captures coastal marine fog moisture via high humidity and cool canopies to grow specialty vegetables and barley despite near-zero rainfall.",
  "Capitalizes on cool, cloudy dryland conditions where low evaporative demand allows spring grains and lentils to thrive on minimal rain.",
  "Eliminates bare-soil evaporation waste in windy, flood-irrigated arid fields by keeping continuous no-till stubble and heat-hardy cover crops."
];

export { cropRotationSolutions, cropRotationReasons };