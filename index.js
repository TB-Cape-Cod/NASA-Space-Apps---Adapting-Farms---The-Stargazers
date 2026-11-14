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