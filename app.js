window.NEVO_BOOT = function () {
  // ====== CONFIG ======
  const API_BASE = "https://script.google.com/macros/s/AKfycbz_Xa0q547X1k8rzWmLJbMFMVFzx7lJJ9RnjdFlREcZKMq7ubSZ5tSr__6FXQqJgRXM/exec";
  const API_KEY  = "nevo_6Rk9Qp2vT8mX4nH7cL1sZ5yJ3wD0aB8eG9fU2kV7";
  const NEVO_PIN = "1776";
  const PIN_TTL_DAYS = 30;

  const COURSE = { carParSec: 4 * 60 + 20, truckParSec: 5 * 60 + 20, qualifyScore: 80 };
  const LOCATIONS = ["Parallel Park","Backing Alley/Slalom","Garages","Lollipop","Diminishing Lane","Skid Pan","Other (see notes)"];
  const LS_KEY = "nevo_offline_queue_v2";
  const PIN_OK_KEY = "nevo_pin_ok_until_v1";

  const pad2 = n => String(n).padStart(2, "0");
  const fmtMMSS = sec => `${pad2(Math.floor(sec / 60))}:${pad2(sec % 60)}`;
  const clamp0 = n => Math.max(0, n);

  function nowMs(){ return Date.now(); }
  function timeOnly(d){ return d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'}); }
  function getParSec(vehicle){ return vehicle === "truck" ? COURSE.truckParSec : COURSE.carParSec; }

  // ===== PIN GATE =====
  function isUnlocked(){
    const until = Number(localStorage.getItem(PIN_OK_KEY) || 0);
    return until && nowMs() < until;
  }
  function setUnlocked(){
    const ttlMs = PIN_TTL_DAYS * 24 * 60 * 60 * 1000;
    localStorage.setItem(PIN_OK_KEY, String(nowMs() + ttlMs));
  }
  function showPinGate(){
    const gate = document.getElementById("pinGate");
    const input = document.getElementById("pinInput");
    const btn = document.getElementById("pinBtn");
    const err = document.getElementById("pinErr");

    gate.style.display = "flex";
    err.style.display = "none";

    const attempt = () => {
      const val = (input.value || "").trim();
      if(val === NEVO_PIN){
        setUnlocked();
        gate.style.display = "none";
        input.value = "";
        init();
      } else {
        err.style.display = "block";
      }
    };

    btn.onclick = attempt;
    input.onkeydown = (e)=>{ if(e.key==="Enter") attempt(); };
    setTimeout(()=>input.focus(), 50);
  }

  // ====== STATE ======
  function newLaneState(){
    return Object.seal({
      running:false,
      paused:false,
      startMs:null,
      endMs:null,
      timerInterval:null,
      pausedAtMs:null,
      pausedTotalMs:0,
      vehicle:"car",
      participant:"",
      notes:"",
      conesBump:0,
      conesCrush:0,
      bumpLocs:new Set(),
      crushLocs:new Set(),
      turnSignal:0,
      stopSign:0
    });
  }

  const lanesState = [newLaneState(), newLaneState(), newLaneState()];
  let rosterNames = [];

  // ====== OFFLINE QUEUE ======
  function loadQueue(){ try{ return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); }catch(e){ return []; } }
  function saveQueue(q){ localStorage.setItem(LS_KEY, JSON.stringify(q)); }
  function queueAdd(item){ const q = loadQueue(); q.push(item); saveQueue(q); updatePendingPill(); }

  function updatePendingPill(){
    const q = loadQueue();
    const pill = document.getElementById("pendingPill");
    const syncBtn = document.getElementById("syncBtn");
    if (pill) pill.textContent = `Pending: ${q.length}`;
    if (syncBtn) syncBtn.disabled = q.length === 0;
  }

  // ====== COMPUTE ======
  function computeTimeFields(lane){
    if(!lane.startMs) return { totalSec:0, overSec:0, timePenalty:0, startTime:"", endTime:"" };

    const effectiveEndMs =
      lane.endMs ? lane.endMs :
      lane.paused ? (lane.pausedAtMs ?? Date.now()) :
      Date.now();

    const rawMs = Math.max(0, effectiveEndMs - lane.startMs);
    const adjMs = Math.max(0, rawMs - (lane.pausedTotalMs || 0));
    const totalSec = Math.floor(adjMs / 1000);

    const parSec = getParSec(lane.vehicle);
    const overSec = Math.max(0, totalSec - parSec);
    const startedMinutesOver = overSec === 0 ? 0 : Math.ceil(overSec / 60);
    const timePenalty = startedMinutesOver * 5;

    const startTime = timeOnly(new Date(lane.startMs));
    const endTime = lane.endMs ? timeOnly(new Date(lane.endMs)) : "";

    return { totalSec, overSec, timePenalty, startTime, endTime };
  }

  function computePenalties(lane){
    const bumpPenalty = lane.conesBump * 1;
    const crushPenalty = lane.conesCrush * 5;
    const signalPenalty = lane.turnSignal * 1;
    const stopPenalty = lane.stopSign * 5;
    return bumpPenalty + crushPenalty + signalPenalty + stopPenalty;
  }

  function computeScore(lane){
    const { timePenalty } = computeTimeFields(lane);
    const nonTimePenalty = computePenalties(lane);
    const totalPenalty = nonTimePenalty + timePenalty;
    const score = Math.max(0, 100 - totalPenalty);
    const status = score >= COURSE.qualifyScore ? "Qualifying" : "Non-Qualifying";
    return { score, status, nonTimePenalty, timePenalty, totalPenalty };
  }

  // ====== UI ======
  function escapeHtml(str){
    return String(str||"")
      .replaceAll("&","&amp;")
      .replaceAll("<","&lt;")
      .replaceAll(">","&gt;")
      .replaceAll('"',"&quot;")
      .replaceAll("'","&#039;");
  }

  function countCard(title, idx, key){
    const lane = lanesState[idx];
    const val = lane[key] || 0;
    const needsLoc = (key==="conesBump" || key==="conesCrush");

    const locs = needsLoc ? `
      <div class="locBlock" style="display:${val>0?"flex":"none"}">
        <div class="locTitle">${key==="conesBump"?"Bump locations (select at least 1)":"Crush locations (select at least 1)"}</div>
        <div class="locList">
          ${LOCATIONS.map(loc=>{
            const checked = (key==="conesBump"? lane.bumpLocs : lane.crushLocs).has(loc);
            return `
              <label class="locItem">
                <input type="checkbox" data-action="${key==="conesBump"?"bumpLoc":"crushLoc"}" data-loc="${escapeHtml(loc)}"${checked?" checked":""}/>
                <span>${escapeHtml(loc)}</span>
              </label>
            `;
          }).join("")}
        </div>
      </div>
    ` : "";

    return `
      <div class="card" data-key="${key}">
        <div class="cardHeader">
          <div class="title">${title}</div>
          <div class="count" data-role="count">${val}</div>
        </div>
        <div class="stepper">
          <button data-action="dec" data-key="${key}">−</button>
          <button data-action="inc" data-key="${key}">+</button>
        </div>
        ${locs}
      </div>
    `;
  }

  function laneTemplate(idx){
    const lane = lanesState[idx];
    const par = getParSec(lane.vehicle);
    const armed = !!lane.startMs;
    const ended = !!lane.endMs;

    const { status } = computeScore(lane);
    const participantOptions = rosterNames.map(n=>`<option value="${escapeHtml(n)}"${lane.participant===n?" selected":""}>${escapeHtml(n)}</option>`).join("");
    const pauseLabel = lane.paused ? "Resume" : "Pause";

    return `
      <div class="lane ${lane.running ? "running":""} ${armed ? "armed":""}" data-idx="${idx}">
        <div class="laneInner">

          <div class="topGrid">
            <div>
              <div class="label">Participant</div>
              <select data-role="participant">
                <option value="">Select participant</option>
                ${participantOptions}
              </select>
            </div>

            <div class="timerBlock">
              <div class="timer" data-role="timer">00:00</div>
              <div class="timerMeta">
                Time: ${fmtMMSS(par)} • Vehicle: ${lane.vehicle==="truck"?"Truck":"Car"}
                ${lane.paused && !ended ? " • Paused" : ""}
                ${lane.endMs ? " • Ended" : ""}
              </div>
            </div>
          </div>

          <div class="btnRow">
            <button class="btnStart" data-action="start" ${lane.running || lane.paused || ended ? "disabled":""}>Start</button>
            <button class="btnPause" data-action="pauseToggle" ${(!armed || ended) ? "disabled":""} ${(!lane.running && !lane.paused) ? "disabled":""}>${pauseLabel}</button>
            <button class="btnEnd" data-action="end" ${(!lane.running && !lane.paused) ? "disabled":""}>End</button>
            <button class="btnClear" data-action="clear">Clear</button>
          </div>

          <div class="hideUntilStart">
            <div class="notesRow" style="margin:8px 0 12px;">
              <div class="label">Notes</div>
              <textarea data-role="notes" placeholder="optional">${escapeHtml(lane.notes||"")}</textarea>
            </div>

            <div class="grid2">
              ${countCard("Cones (Bump)", idx, "conesBump")}
              ${countCard("Cones (Crush)", idx, "conesCrush")}
              ${countCard("Turn Signal", idx, "turnSignal")}
              ${countCard("Stop Sign", idx, "stopSign")}
            </div>

            <div class="bottom">
              <div class="summary" data-role="summary"></div>
              <div class="statusWrap">
                <div class="statusPill" data-role="status">${status}</div>
                <div class="subline">Over time: -5 per started minute.</div>
                <button class="submitBtn" data-action="submit" disabled>Submit</button>
              </div>
            </div>
          </div>

        </div>
      </div>
    `;
  }

  function render(){
    const lanes = document.getElementById("lanes");
    lanes.innerHTML = lanesState.map((_,i)=>laneTemplate(i)).join("");
    attachHandlers();
    updatePendingPill();
    lanesState.forEach((_,i)=>tickTimer(i));
  }

  function attachHandlers(){
    document.getElementById("syncBtn").onclick = syncQueue;

    document.querySelectorAll(".lane").forEach(laneEl=>{
      const idx = Number(laneEl.dataset.idx);
      const lane = lanesState[idx];

      laneEl.querySelectorAll("button[data-action]").forEach(btn=>{
        btn.addEventListener("click", ()=>handleAction(idx, btn.dataset.action, btn.dataset.key));
      });

      laneEl.querySelector('[data-role="participant"]').addEventListener("change", (e)=>{
        lane.participant = e.target.value;
        updateSummary(idx);
      });

      const notesEl = laneEl.querySelector('[data-role="notes"]');
      if(notesEl){
        notesEl.addEventListener("input", (e)=>{ lane.notes = e.target.value; });
      }

      laneEl.querySelectorAll('input[type="checkbox"][data-action="bumpLoc"]').forEach(cb=>{
        cb.addEventListener("change", ()=>{
          const loc=cb.dataset.loc;
          if(cb.checked) lane.bumpLocs.add(loc); else lane.bumpLocs.delete(loc);
          updateSummary(idx);
        });
      });
      laneEl.querySelectorAll('input[type="checkbox"][data-action="crushLoc"]').forEach(cb=>{
        cb.addEventListener("change", ()=>{
          const loc=cb.dataset.loc;
          if(cb.checked) lane.crushLocs.add(loc); else lane.crushLocs.delete(loc);
          updateSummary(idx);
        });
      });
    });
  }

  function startTimerInterval(i){
    const lane = lanesState[i];
    if(lane.timerInterval) clearInterval(lane.timerInterval);
    lane.timerInterval = setInterval(()=>tickTimer(i), 250);
  }
  function stopTimerInterval(i){
    const lane = lanesState[i];
    if(lane.timerInterval){ clearInterval(lane.timerInterval); lane.timerInterval=null; }
  }

  function handleAction(idx, action, key){
    const lane = lanesState[idx];

    if(action==="start"){
      if(lane.running || lane.paused) return;
      if(lane.endMs) return;

      lane.running = true;
      lane.paused = false;
      lane.startMs = Date.now();
      lane.endMs = null;
      lane.pausedAtMs = null;
      lane.pausedTotalMs = 0;

      startTimerInterval(idx);
      render();
      return;
    }

    if(action==="pauseToggle"){
      if(lane.running && !lane.paused){
        lane.running = false;
        lane.paused = true;
        lane.pausedAtMs = Date.now();
        stopTimerInterval(idx);
        render();
        return;
      }

      if(lane.paused && !lane.running && !lane.endMs){
        const now = Date.now();
        const pausedChunk = Math.max(0, now - (lane.pausedAtMs || now));
        lane.pausedTotalMs = (lane.pausedTotalMs || 0) + pausedChunk;

        lane.paused = false;
        lane.running = true;
        lane.pausedAtMs = null;

        startTimerInterval(idx);
        render();
        return;
      }
      return;
    }

    if(action==="end"){
      if(!lane.running && !lane.paused) return;

      if(lane.paused){
        const now = Date.now();
        const pausedChunk = Math.max(0, now - (lane.pausedAtMs || now));
        lane.pausedTotalMs = (lane.pausedTotalMs || 0) + pausedChunk;
        lane.pausedAtMs = null;
        lane.paused = false;
      }

      lane.running = false;
      lane.endMs = Date.now();
      stopTimerInterval(idx);
      render();
      return;
    }

    if(action==="clear"){
      stopTimerInterval(idx);
      lanesState[idx] = newLaneState();
      render();
      return;
    }

    if(action==="inc" || action==="dec"){
      const delta = action==="inc" ? 1 : -1;
      lane[key] = clamp0((lane[key]||0) + delta);

      if(key==="conesBump" && lane[key]===0) lane.bumpLocs.clear();
      if(key==="conesCrush" && lane[key]===0) lane.crushLocs.clear();

      render();
      return;
    }

    if(action==="submit"){
      submitLane(idx);
      return;
    }
  }

  function tickTimer(idx){
    const laneEl = document.querySelector(`.lane[data-idx="${idx}"]`);
    if(!laneEl) return;

    const lane = lanesState[idx];
    const { totalSec } = computeTimeFields(lane);

    laneEl.querySelector('[data-role="timer"]').textContent = fmtMMSS(totalSec);
    updateSummary(idx);
  }

  function updateSummary(idx){
    const laneEl = document.querySelector(`.lane[data-idx="${idx}"]`);
    if(!laneEl) return;
    const lane = lanesState[idx];
    if(!lane.startMs) return;

    const { timePenalty } = computeTimeFields(lane);
    const { score, status, nonTimePenalty, totalPenalty } = computeScore(lane);

    const sum = laneEl.querySelector('[data-role="summary"]');
    const statusEl = laneEl.querySelector('[data-role="status"]');
    const submitBtn = laneEl.querySelector('button[data-action="submit"]');

    let warnText = "";
    let ok = true;

    if(lane.conesBump>0 && lane.bumpLocs.size===0){ warnText += "Select at least 1 bump location. "; ok=false; }
    if(lane.conesCrush>0 && lane.crushLocs.size===0){ warnText += "Select at least 1 crush location. "; ok=false; }
    if(!lane.participant) ok=false;
    if(!lane.endMs) ok=false;

    sum.innerHTML =
      `Score: ${score}<br/>
       Non-time penalty: ${nonTimePenalty}<br/>
       Time penalty: ${lane.endMs ? timePenalty : "(pending End)"}<br/>
       Total penalty: ${lane.endMs ? totalPenalty : nonTimePenalty}<br/>
       ${warnText ? `<div class="warn">${escapeHtml(warnText.trim())}</div>` : ""}`;

    statusEl.textContent = status;
    submitBtn.disabled = !ok;
  }

  // ===== Roster via JSONP =====
  function fetchRosterNames(){
    return new Promise((resolve) => {
      const cb = `NEVO_ROSTER_CB_${Math.random().toString(36).slice(2)}`;
      const script = document.createElement("script");

      window[cb] = (data) => {
        try { delete window[cb]; } catch(e) { window[cb] = undefined; }
        script.remove();

        if (!data || data.ok !== true) {
          alert(`Roster fetch failed: ${data && data.error ? data.error : "unknown error"}\n\nMost common fixes:\n- API_KEY mismatch between Code.gs and app.js\n- Apps Script not redeployed after editing Code.gs\n- Web App access not set to Anyone`);
          return resolve([]);
        }

        if (!Array.isArray(data.names)) return resolve([]);
        return resolve(data.names);
      };

      const url = new URL(API_BASE);
      url.searchParams.set("action", "roster");
      url.searchParams.set("key", API_KEY);
      url.searchParams.set("callback", cb);

      script.src = url.toString();
      script.onerror = () => {
        try { delete window[cb]; } catch(e) { window[cb] = undefined; }
        script.remove();
        alert("Roster fetch failed (network/script error). Check Web App access is set to Anyone and the /exec URL is correct.");
        resolve([]);
      };

      document.head.appendChild(script);
    });
  }

  // ===== Submit via sendBeacon/no-cors =====
  function postSubmit(payload){
    const url = new URL(API_BASE);
    url.searchParams.set("action", "submit");
    url.searchParams.set("key", API_KEY);

    const body = JSON.stringify(payload);

    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: "application/json" });
      const ok = navigator.sendBeacon(url.toString(), blob);
      return Promise.resolve({ ok });
    }

    return fetch(url.toString(), {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "application/json" },
      body
    }).then(() => ({ ok: true })).catch(() => ({ ok: false }));
  }

  async function submitLane(idx){
    const lane = lanesState[idx];
    const { totalSec, overSec, timePenalty, startTime, endTime } = computeTimeFields(lane);
    const { score, status, totalPenalty } = computeScore(lane);

    const payload = {
      participant: lane.participant,
      startTime,
      endTime,
      totalTime: fmtMMSS(totalSec),
      overSeconds: overSec,
      timePenalty,
      conesBump: lane.conesBump,
      bumpLocation: Array.from(lane.bumpLocs).join(", "),
      conesCrush: lane.conesCrush,
      crushLocation: Array.from(lane.crushLocs).join(", "),
      turnSignal: lane.turnSignal,
      stopSign: lane.stopSign,
      totalPenalty,
      score,
      status,
      notes: lane.notes || ""
    };

    try{
      const res = await postSubmit(payload);
      if(!res || !res.ok) throw new Error("send_failed");
      handleAction(idx, "clear");
    }catch(e){
      queueAdd(payload);
      handleAction(idx, "clear");
    }
  }

  async function syncQueue(){
    const q = loadQueue();
    if(q.length===0) return;

    const remaining=[];
    for(const item of q){
      try{
        const res = await postSubmit(item);
        if(!(res && res.ok)) remaining.push(item);
      }catch(e){
        remaining.push(item);
      }
    }
    saveQueue(remaining);
    updatePendingPill();
    alert(remaining.length===0 ? "Synced!" : `Synced some. Remaining: ${remaining.length}`);
  }

  async function init(){
    document.getElementById("syncBtn").disabled = true;
    updatePendingPill();

    rosterNames = await fetchRosterNames();
    if (rosterNames.length === 0) {
      alert("Roster loaded 0 names.\n\nIf your roster URL test returns ok:true but names is empty, check:\n- Sheet name is exactly 'Roster'\n- Names are in column A starting at A2\n- Spreadsheet ID in Code.gs is correct");
    }

    render();
  }

  if (isUnlocked()) init();
  else showPinGate();
};
