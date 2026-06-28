
document.addEventListener("DOMContentLoaded", () => {
  const BASE = window.location.origin;
  const map = L.map("map", {preferCanvas: false}).setView([12.9716, 77.5946], 11);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  const housesCluster  = L.markerClusterGroup({ chunkedLoading: true });
  const aqiLayer       = L.layerGroup();
  const metroLayer     = L.layerGroup();
  const metroLineLayer = L.layerGroup();
  const schoolsLayer   = L.layerGroup();
  const busLayer       = L.layerGroup();
  const hospitalLayer  = L.layerGroup();

  map.addLayer(housesCluster);
  map.addLayer(metroLineLayer);
  map.addLayer(aqiLayer);

  const overlays = {
    "Houses": housesCluster, "AQI": aqiLayer,
    "Metro Stations": metroLayer, "Metro Lines": metroLineLayer,
    "Schools": schoolsLayer, "Bus Stops": busLayer, "Hospitals": hospitalLayer
  };
  L.control.layers(null, overlays, { collapsed: false, position: "topright" }).addTo(map);

  setTimeout(() => {
    const indexContainer  = document.getElementById("index-container");
    const leafletLayersBox = document.querySelector(".leaflet-control-layers");
    if (leafletLayersBox && indexContainer) {
      indexContainer.innerHTML = "";
      leafletLayersBox.style.cssText = "display:block;position:static;box-shadow:none;background:transparent;padding:0;";
      indexContainer.appendChild(leafletLayersBox);
    }
  }, 300);

  const houseIcon   = L.icon({ iconUrl: "https://cdn-icons-png.flaticon.com/512/69/69524.png",   iconSize:[28,28], iconAnchor:[14,14] });
  const metroIcon   = L.icon({ iconUrl: "https://cdn-icons-png.flaticon.com/512/437/437795.png",  iconSize:[20,20], iconAnchor:[10,10] });
  const busIcon     = L.icon({ iconUrl: "https://cdn-icons-png.flaticon.com/512/3233/3233830.png",iconSize:[18,18], iconAnchor:[9,9]  });
  const schoolIcon  = L.icon({ iconUrl: "https://cdn-icons-png.flaticon.com/512/2823/2823055.png",iconSize:[20,20], iconAnchor:[10,10] });
  const hospitalIcon= L.icon({ iconUrl: "https://cdn-icons-png.flaticon.com/512/2967/2967350.png",iconSize:[22,22], iconAnchor:[11,11] });

  let allHouses          = [];
  let currentHouseMarkers= [];
  let lastHighlight      = [];
  let thinkingInterval   = null;
  let bhkChartInst       = null;
  let aqiChartInst       = null;

  // ── helpers ──
  function showLoading(){ document.getElementById("loading-overlay").classList.remove("hidden"); }
  function hideLoading(){ document.getElementById("loading-overlay").classList.add("hidden"); }

  function startThinking(){
    const el = document.getElementById('ai-response');
    let dots = 0;
    el.innerHTML = "🤖 Thinking";
    if (thinkingInterval) clearInterval(thinkingInterval);
    thinkingInterval = setInterval(() => {
      dots = (dots + 1) % 4;
      el.innerHTML = "🤖 Thinking" + ".".repeat(dots);
    }, 400);
  }
  function stopThinking(text){
    if (thinkingInterval){ clearInterval(thinkingInterval); thinkingInterval = null; }
    if (text != null) document.getElementById('ai-response').innerHTML = text;
  }
  async function fetchJSON(url){
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }

  // ── livability helpers ──
  function lvCategory(score){
    if (score >= 75) return { label: "Excellent", cls: "lv-excellent" };
    if (score >= 55) return { label: "Good",      cls: "lv-good" };
    if (score >= 35) return { label: "Average",   cls: "lv-average" };
    return              { label: "Poor",      cls: "lv-poor" };
  }
  function lvBarColor(score){
    if (score >= 75) return "#16a34a";
    if (score >= 55) return "#2563eb";
    if (score >= 35) return "#ca8a04";
    return "#dc2626";
  }
  function lvBreakdown(h){
    const fmt = v => (v != null ? v + " km" : "—");
    const aqiFmt = v => (v != null ? Math.round(v) : "—");
    return `
      <div class="lv-breakdown">
        🏫 School: <span>${fmt(h.nearest_school_km)}</span> &nbsp;
        🚇 Metro: <span>${fmt(h.nearest_metro_km)}</span><br>
        🏥 Hospital: <span>${fmt(h.nearest_hospital_km)}</span> &nbsp;
        🚌 Bus: <span>${fmt(h.nearest_bus_km)}</span><br>
        🌫️ AQI: <span>${aqiFmt(h.nearest_aqi_val)}</span>
      </div>`;
  }

  // ── house marker ──
  function addHouseMarker(h){
    if (!isFinite(h.latitude) || !isFinite(h.longitude)) return null;
    const m = L.marker([Number(h.latitude), Number(h.longitude)], { icon: houseIcon });

    const score = h.livability_score ?? null;
    const cat   = score != null ? lvCategory(score) : null;

    const popup = `
      <strong>${h.location || "Property"}</strong><br/>
      ${h.size_num  ? h.size_num  + " BHK<br/>" : ""}
      ${h.price_lakh? "₹ " + h.price_lakh + " L<br/>" : ""}
      <hr>
      🏫 ${h.nearest_school_km} km to school<br/>
      🏥 ${h.nearest_hospital_km} km to hospital<br/>
      🚇 ${h.nearest_metro_km} km to metro<br/>
      🚌 ${h.nearest_bus_km} km to bus stop<br/>
      🌫️ AQI: ${h.nearest_aqi_val}
      ${cat ? `<br><span class="lv-badge ${cat.cls}" style="margin-top:4px">⭐ ${score} — ${cat.label}</span>` : ""}
    `;
    m.bindPopup(popup);

    m.on("click", () => {
      const scoreHTML = score != null ? `
        <div style="margin:12px 0 4px;display:flex;align-items:center;gap:8px;">
          <span style="font-size:15px;font-weight:700;color:#0f172a;">Livability Score</span>
          <span class="lv-badge ${cat.cls}">⭐ ${score} — ${cat.label}</span>
        </div>
        <div class="lv-bar-wrap"><div class="lv-bar" style="width:${score}%;background:${lvBarColor(score)};"></div></div>
        ${lvBreakdown(h)}
      ` : "";

      const content = `
        <h2 style="margin-bottom:4px;">${h.location || "Property"}</h2>
        <p style="margin:0 0 8px;"><strong>${h.size_num ?? "—"} BHK • ₹ ${h.price_lakh ?? "—"} Lakh</strong></p>
        ${scoreHTML}
        <div class="amenities-grid">
          <div class="amenity-box"><div class="amenity-label">School</div><div class="amenity-value">${h.nearest_school_km ?? "—"} km</div></div>
          <div class="amenity-box"><div class="amenity-label">Metro</div><div class="amenity-value">${h.nearest_metro_km ?? "—"} km</div></div>
          <div class="amenity-box"><div class="amenity-label">Bus Stop</div><div class="amenity-value">${h.nearest_bus_km ?? "—"} km</div></div>
          <div class="amenity-box"><div class="amenity-label">AQI</div><div class="amenity-value">${h.nearest_aqi_val != null ? Math.round(h.nearest_aqi_val) : "—"}</div></div>
          <div class="amenity-box"><div class="amenity-label">Hospital</div><div class="amenity-value">${h.nearest_hospital_km ?? "—"} km</div></div>
        </div>
        <button id="directions-btn" class="directions-btn">🚗 Get Directions</button>
      `;
      document.getElementById("panel-content").innerHTML = content;
      document.getElementById("info-panel").classList.add("show");
      window.selectedHouse = { lat: h.latitude, lon: h.longitude, name: h.location };
    });

    housesCluster.addLayer(m);
    currentHouseMarkers.push(m);
    return m;
  }

  function clearHouses(){
    housesCluster.clearLayers();
    currentHouseMarkers = [];
  }

  // ── layer renderers (unchanged) ──
  function addMetroGeoJSON(geojson){
    L.geoJSON(geojson, {
      onEachFeature(feature, layer){
        if (feature.geometry?.type === 'Point'){
          const name = feature.properties?.Name || feature.properties?.name || feature.properties?.station_name || 'Station';
          const mk = L.marker(layer.getLatLng(), {icon: metroIcon}).bindPopup(`<b>🚇 ${name}</b>`);
          metroLayer.addLayer(mk);
        } else if (feature.geometry?.type === 'LineString'){
          metroLineLayer.addLayer(L.geoJSON(feature, {style:{color:'#3333FF',weight:3,opacity:0.9}}));
        }
      }
    });
  }
  function addAQIPoints(aqiRecords){
    aqiLayer.clearLayers();
    aqiRecords.forEach(p => {
      const lat = Number(p.latitude || p.lat);
      const lon = Number(p.longitude || p.lon);
      const val = Number(p.aqi || p.AQI || p.aqi_value);
      if (!isFinite(lat)||!isFinite(lon)||!isFinite(val)) return;
      const color = val<=50?"#00E400":val<=100?"#FFFF00":val<=150?"#FF7E00":val<=200?"#FF0000":val<=300?"#99004C":"#7E0023";
      L.circleMarker([lat,lon],{radius:8,color:'#222',weight:1,fillColor:color,fillOpacity:0.9})
        .bindPopup(`<b>🌫️ ${p.station_name||p.station||'AQI'}</b><br/>AQI: ${val}`)
        .addTo(aqiLayer);
    });
  }
  function addSchoolsGeoJSON(geojson){
    schoolsLayer.clearLayers();
    L.geoJSON(geojson, {
      pointToLayer(feature, latlng){
        const name = feature.properties?.SCHName || feature.properties?.Name || feature.properties?.name || 'School';
        const mk = L.marker(latlng, {icon: schoolIcon}).bindPopup(`<b>🏫 ${name}</b>`);
        schoolsLayer.addLayer(mk);
        return null;
      }
    });
  }
  function addBusPoints(records){
    busLayer.clearLayers();
    records.forEach(b => {
      const lat = Number(b.latitude||b.lat||b.LATITUDE);
      const lon = Number(b.longitude||b.lon||b.LONGITUDE);
      if (!isFinite(lat)||!isFinite(lon)) return;
      L.marker([lat,lon],{icon:busIcon})
        .bindPopup(`<b>🚌 ${b.StopName||b["Bus Stops"]||b.name||'Bus Stop'}</b>`)
        .addTo(busLayer);
    });
  }

  // ── REAL dashboard (Feature 2) ──
  function updateDashboard(){
    // Count metrics
    document.getElementById("d-houses").innerText   = allHouses.length;
    document.getElementById("d-aqi").innerText      = aqiLayer.getLayers().length;
    document.getElementById("d-metro").innerText    = metroLayer.getLayers().length;
    document.getElementById("d-schools").innerText  = schoolsLayer.getLayers().length;
    document.getElementById("d-hospitals").innerText= hospitalLayer.getLayers().length;

    // Median price from allHouses
    const prices = allHouses.map(h => h.price_lakh).filter(p => p && isFinite(p)).sort((a,b)=>a-b);
    const median = prices.length ? prices[Math.floor(prices.length/2)] : null;
    const medEl  = document.getElementById("d-median-price");
    if (medEl) medEl.innerText = median != null ? "₹" + median.toFixed(0) + "L" : "—";

    // BHK distribution chart (real data)
    const bhkCount = {};
    allHouses.forEach(h => {
      const k = h.size_num ? String(Math.round(h.size_num)) : null;
      if (k) bhkCount[k] = (bhkCount[k]||0) + 1;
    });
    const bhkLabels = Object.keys(bhkCount).sort();
    const bhkValues = bhkLabels.map(k => bhkCount[k]);

    const bhkCtx = document.getElementById("chart-bhk");
    if (bhkCtx){
      if (bhkChartInst) bhkChartInst.destroy();
      bhkChartInst = new Chart(bhkCtx, {
        type: "bar",
        data: {
          labels: bhkLabels.map(k => k+"BHK"),
          datasets: [{ data: bhkValues, backgroundColor: "#3b82f6", borderRadius: 4 }]
        },
        options: {
          plugins: { legend: { display: false } },
          scales: { y: { beginAtZero: true, ticks: { font: { size: 10 } } }, x: { ticks: { font: { size: 10 } } } },
          responsive: true, maintainAspectRatio: false
        }
      });
    }

    // AQI distribution from layer fill colours (real data from loaded points)
    const aqiCats = { Good:0, Moderate:0, Unhealthy:0 };
    aqiLayer.eachLayer(mk => {
      const c = mk.options.fillColor;
      if (c === "#00E400") aqiCats.Good++;
      else if (c === "#FFFF00") aqiCats.Moderate++;
      else aqiCats.Unhealthy++;
    });
    const aqiCtx = document.getElementById("chart-aqi");
    if (aqiCtx){
      if (aqiChartInst) aqiChartInst.destroy();
      aqiChartInst = new Chart(aqiCtx, {
        type: "doughnut",
        data: {
          labels: Object.keys(aqiCats),
          datasets: [{ data: Object.values(aqiCats), backgroundColor: ["#16a34a","#facc15","#dc2626"] }]
        },
        options: {
          plugins: { legend: { display: true, position: "bottom", labels: { font: { size: 10 }, boxWidth: 10 } } },
          responsive: true, maintainAspectRatio: false
        }
      });
    }
  }

  // ── initial load ──
  async function initialLoad(){
    showLoading();
    try {
      const houses = await fetchJSON(`${BASE}/houses`);
      allHouses = houses.map(h => ({
        latitude:  Number(h.latitude||h.lat||h.y||0),
        longitude: Number(h.longitude||h.lon||h.x||0),
        location:  h.location||h.location_text||'',
        price_lakh:h.price_lakh||h.price||null,
        size_num:  h.size_num||h.size||null
      })).filter(h => isFinite(h.latitude)&&isFinite(h.longitude));
      clearHouses();
      allHouses.forEach(addHouseMarker);
      if (currentHouseMarkers.length){
        try { map.fitBounds(L.featureGroup(currentHouseMarkers).getBounds(),{padding:[40,40],maxZoom:13}); } catch(e){}
      }
      try { addAQIPoints(await fetchJSON(`${BASE}/aqi`)); }       catch(e){ console.warn("AQI",e); }
      try { addMetroGeoJSON(await fetchJSON(`${BASE}/metro`)); }  catch(e){ console.warn("Metro",e); }
      try { addSchoolsGeoJSON(await fetchJSON(`${BASE}/schools`));} catch(e){ console.warn("Schools",e); }
      try { addBusPoints(await fetchJSON(`${BASE}/bus`)); }        catch(e){ console.warn("Bus",e); }
      try {
        const hospitals = await fetchJSON(`${BASE}/hospitals`);
        hospitals.forEach(h => L.marker([h.lat,h.lon],{icon:hospitalIcon}).bindPopup(`<b>🏥 ${h.name}</b>`).addTo(hospitalLayer));
      } catch(e){ console.warn("Hospitals",e); }
    } catch(err){
      console.error("Initial load error:", err);
      stopThinking("🚨 Couldn't load data. Make sure backend is running.");
    } finally {
      updateDashboard();
      hideLoading();
    }
  }

  // ── layer checkbox controls ──
  document.getElementById("layer-houses").addEventListener("change", e => e.target.checked ? map.addLayer(housesCluster) : map.removeLayer(housesCluster));
  document.getElementById("layer-aqi").addEventListener("change",    e => e.target.checked ? map.addLayer(aqiLayer)     : map.removeLayer(aqiLayer));
  document.getElementById("layer-metro").addEventListener("change",  e => e.target.checked ? map.addLayer(metroLayer)   : map.removeLayer(metroLayer));
  document.getElementById("layer-metro-lines").addEventListener("change", e => e.target.checked ? map.addLayer(metroLineLayer) : map.removeLayer(metroLineLayer));
  document.getElementById("layer-schools").addEventListener("change",e => e.target.checked ? map.addLayer(schoolsLayer) : map.removeLayer(schoolsLayer));
  document.getElementById("layer-bus").addEventListener("change",    e => e.target.checked ? map.addLayer(busLayer)     : map.removeLayer(busLayer));
  document.getElementById("layer-hospitals").addEventListener("change",e => e.target.checked ? map.addLayer(hospitalLayer) : map.removeLayer(hospitalLayer));

  // ── highlight ──
  function highlightMarkers(markers, duration=3000){
    lastHighlight.forEach(m => { try{ m.getElement()?.classList.remove('house-highlight'); }catch(e){} });
    lastHighlight = [];
    markers.forEach(m => {
      try { m.openPopup(); m.getElement()?.classList.add('house-highlight'); lastHighlight.push(m); } catch(e){}
    });
    setTimeout(() => {
      lastHighlight.forEach(m => { try{ m.getElement()?.classList.remove('house-highlight'); }catch(e){} });
      lastHighlight = [];
    }, duration);
  }

  // ── COMPARE (Feature 3) ──
  let compareList = [];   // max 2 houses

  function toggleCompare(h, btn){
    const idx = compareList.findIndex(c => c.latitude === h.latitude && c.longitude === h.longitude);
    if (idx > -1){
      compareList.splice(idx, 1);
      btn.classList.remove("selected");
    } else {
      if (compareList.length >= 2){
        // deselect oldest
        const oldBtn = document.querySelector('.compare-btn.selected');
        if (oldBtn){ oldBtn.classList.remove("selected"); }
        compareList.shift();
      }
      compareList.push(h);
      btn.classList.add("selected");
    }
    if (compareList.length === 2) showCompare();
    else closeCompare();
  }

  function showCompare(){
    const [a, b] = compareList;
    const catA = lvCategory(a.livability_score ?? 0);
    const catB = lvCategory(b.livability_score ?? 0);

    function row(label, va, vb, lowerBetter=true){
      const na = parseFloat(va), nb = parseFloat(vb);
      let clsA="", clsB="";
      if (!isNaN(na) && !isNaN(nb) && na !== nb){
        const aWins = lowerBetter ? na < nb : na > nb;
        clsA = aWins ? "cmp-win" : "cmp-lose";
        clsB = aWins ? "cmp-lose" : "cmp-win";
      }
      return `<tr>
        <td class="cmp-row-label">${label}</td>
        <td class="${clsA}">${va ?? "—"}</td>
        <td class="${clsB}">${vb ?? "—"}</td>
      </tr>`;
    }

    document.getElementById("compare-table-wrap").innerHTML = `
      <table class="cmp-table">
        <thead><tr>
          <th>Metric</th>
          <th>${a.location || "Property A"}</th>
          <th>${b.location || "Property B"}</th>
        </tr></thead>
        <tbody>
          ${row("Price (₹L)",     a.price_lakh,          b.price_lakh,          true)}
          ${row("BHK",           a.size_num,             b.size_num,             false)}
          ${row("Livability /100",a.livability_score,    b.livability_score,    false)}
          ${row("AQI",           a.nearest_aqi_val != null ? Math.round(a.nearest_aqi_val) : null,
                                  b.nearest_aqi_val != null ? Math.round(b.nearest_aqi_val) : null, true)}
          ${row("Metro (km)",    a.nearest_metro_km,    b.nearest_metro_km,    true)}
          ${row("School (km)",   a.nearest_school_km,   b.nearest_school_km,   true)}
          ${row("Hospital (km)", a.nearest_hospital_km, b.nearest_hospital_km, true)}
          ${row("Bus Stop (km)", a.nearest_bus_km,      b.nearest_bus_km,      true)}
        </tbody>
        <tfoot><tr><td colspan="3" style="font-size:11px;color:#64748b;padding-top:8px;">
          <span style="color:#15803d;font-weight:700;">Green</span> = better value
        </td></tr></tfoot>
      </table>
    `;
    document.getElementById("compare-modal").classList.add("show");
  }

  function closeCompare(){
    document.getElementById("compare-modal").classList.remove("show");
  }
  window.closeCompare = closeCompare;

  // ── results panel ──
  function renderResultsPanel(list){
    const panel   = document.getElementById('results-panel');
    const listEl  = document.getElementById('results-list');
    const countEl = document.getElementById('results-count');
    listEl.innerHTML = '';
    countEl.innerText = list.length;
    if (!list.length){ panel.classList.add('hidden'); return; }

    list.forEach((h, i) => {
      const score = h.livability_score ?? null;
      const cat   = score != null ? lvCategory(score) : null;
      const item  = document.createElement('div');
      item.className = 'result-item';
      item.innerHTML = `
        <div class="result-main">
          <span class="result-price">₹ ${h.price_lakh ?? '—'} L</span>
          <span class="result-bhk">${h.size_num ?? '—'} BHK</span>
        </div>
        <div class="result-location">${h.location || 'Unknown location'}</div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:6px;">
          ${cat ? `<span class="lv-badge ${cat.cls}">⭐ ${score} — ${cat.label}</span>` : ''}
          <button class="compare-btn" data-idx="${i}">+ Compare</button>
        </div>
      `;
      item.querySelector('.result-item, div')?.addEventListener('click', ev => {
        if (!ev.target.classList.contains('compare-btn')) focusOnProperty(i);
      });
      item.addEventListener('click', ev => {
        if (!ev.target.classList.contains('compare-btn')) focusOnProperty(i);
      });
      const cmpBtn = item.querySelector('.compare-btn');
      cmpBtn.addEventListener('click', ev => {
        ev.stopPropagation();
        toggleCompare(h, cmpBtn);
      });
      listEl.appendChild(item);
    });
    panel.classList.remove('hidden');
  }



  function closeResultsPanel(){ document.getElementById('results-panel').classList.add('hidden'); }
  window.closeResultsPanel = closeResultsPanel;

  function focusOnProperty(index){
    const marker = currentHouseMarkers[index];
    if (!marker) return;
    try { map.flyTo(marker.getLatLng(), 16, { duration: 0.8 }); } catch(e){}
    highlightMarkers([marker], 3000);
    marker.fire('click');
  }

  // ── show filtered houses ──
  function showOnlyHouses(list){
    clearHouses();
    compareList = [];
    closeCompare();
    const markers = [];
    const validList = [];
    list.forEach(h => {
      if (!isFinite(h.latitude)||!isFinite(h.longitude)) return;
      const marker = addHouseMarker(h);
      if (marker){ markers.push(marker); validList.push(h); }
    });
    renderResultsPanel(validList);
    if (!markers.length){ stopThinking("No houses to show."); return; }
    try { map.flyToBounds(L.featureGroup(markers).getBounds(),{padding:[50,50],maxZoom:15,duration:1.2}); } catch(e){}
    highlightMarkers(markers.slice(0,6));
  }

  // ── AI response handler ──
  async function handleAIResponse(resp){
    const action = resp.action || null;
    const data   = resp.data || resp.results || resp;
    const qText  = document.getElementById('chat-input').value.toLowerCase();

    const layerMap = [
      { kw: "school",              layer: schoolsLayer  },
      { kw: "metro",               layer: metroLayer    },
      { kw: "bus",                 layer: busLayer      },
      { kw: ["aqi","air"],         layer: aqiLayer,    alwaysOn: true },
      { kw: "hospital",            layer: hospitalLayer },
    ];
    layerMap.forEach(({ kw, layer, alwaysOn }) => {
      const match = Array.isArray(kw) ? kw.some(k => qText.includes(k)) : qText.includes(kw);
      if (match){ if (!map.hasLayer(layer)) map.addLayer(layer); }
      else if (!alwaysOn){ if (map.hasLayer(layer)) map.removeLayer(layer); }
    });

    await new Promise(r => setTimeout(r, 200));

    if (action === 'filter' && Array.isArray(data)){ showOnlyHouses(data); stopThinking(resp.response || `Found ${data.length} properties.`); return; }
    if (!action && Array.isArray(resp.results))     { showOnlyHouses(resp.results); stopThinking(resp.response || `Found ${resp.results.length} properties.`); return; }
    if (action === 'focus' && data){
      const lat = Number(data.lat ?? data.latitude);
      const lon = Number(data.lon ?? data.longitude);
      if (isFinite(lat)&&isFinite(lon)){
        map.flyTo([lat,lon],14,{duration:0.9});
        const mk = L.marker([lat,lon]).addTo(map).bindPopup(`<b>${data.name||'Location'}</b>`).openPopup();
        setTimeout(()=>{ try{map.removeLayer(mk);}catch(e){} }, 6000);
      }
      stopThinking(resp.response || `Focused on ${data.name||''}`);
      return;
    }
    if (Array.isArray(data)){ showOnlyHouses(data); stopThinking(resp.response || `Found ${data.length} properties.`); return; }
    stopThinking(resp.response || "No actionable results.");
  }

  function closeInfoPanel(){ document.getElementById("info-panel").classList.remove("show"); }
  window.closeInfoPanel = closeInfoPanel;

  // ── AI send ──
  document.getElementById('send-button').addEventListener('click', async () => {
    const q = document.getElementById('chat-input').value.trim();
    if (!q) return;
    startThinking(); showLoading();
    try {
      const res  = await fetch(`${BASE}/api/ai_query`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({query:q}) });
      const data = await res.json();
      hideLoading();
      if (data.error){ stopThinking(data.error); return; }
      document.getElementById("ai-chat-box").classList.add("minimized");
      await handleAIResponse(data);
    } catch(err){
      hideLoading();
      stopThinking("🚨 Couldn't connect to backend.");
    }
  });

  const toggleBtn = document.getElementById("toggle-chat");
  const chatBox = document.getElementById("ai-chat-box");

  toggleBtn.addEventListener("click", () => {

      chatBox.classList.toggle("collapsed");

      toggleBtn.textContent =
          chatBox.classList.contains("collapsed")
          ? "▸"
          : "▾";

  });

  // ── reset / show all ──
  document.querySelectorAll('#reset-view').forEach(btn => btn.addEventListener('click', () => {
    clearHouses(); allHouses.forEach(addHouseMarker);
    try{ map.setView([12.9716,77.5946],11); }catch(e){}
    closeResultsPanel(); closeCompare(); stopThinking("Reset to Bengaluru view.");
  }));
  document.querySelectorAll('#show-all').forEach(btn => btn.addEventListener('click', () => {
    clearHouses(); allHouses.forEach(addHouseMarker);
    if (currentHouseMarkers.length){ try{ map.fitBounds(L.featureGroup(currentHouseMarkers).getBounds(),{padding:[40,40],maxZoom:12}); }catch(e){} }
    closeResultsPanel(); closeCompare(); stopThinking("Showing all houses.");
  }));

  // ── theme toggle ──
  document.getElementById('theme-toggle').addEventListener('click', () => {
    document.body.classList.toggle('dark-mode');
    const dark = document.body.classList.contains('dark-mode');
    document.getElementById('theme-toggle').querySelector('.icon').textContent = dark ? '☀️' : '🌙';
    document.getElementById('theme-toggle').querySelector('.label').textContent = dark ? 'Light' : 'Dark';
  });

  // ── directions ──
  document.addEventListener("click", e => {
    if (e.target.id === "directions-btn"){
      if (!window.selectedHouse){ alert("Select a house first!"); return; }
      window.open(`https://www.google.com/maps/dir/?api=1&destination=${window.selectedHouse.lat},${window.selectedHouse.lon}`,"_blank");
    }
    if (e.target.classList.contains("close-btn")) closeInfoPanel();
  });

  initialLoad();
});