// =====================================================
// PAYMENT MODULE — Pio De Roda Cafe and Restaurant
// Separate, self-contained module (payment/payment.html + payment.css +
// payment.js). It is INTENTIONALLY isolated from the reservation system:
//
//   - It only READS the reservation through the backend area of services.js
//     (findReservation — Reservation ID + Booking PIN) and re-checks the
//     reservation's CURRENT status there. A URL parameter, a hidden field, or
//     a query string is NEVER trusted as proof of confirmation.
//   - It NEVER writes to the reservation store and NEVER changes a
//     reservation's status (only the Admin/back end can do that).
//   - Payment status is kept SEPARATE from reservation status.
//   - PAYMENT_TEST_MODE = true → simulated transactions only. No real money,
//     no card details, no payment passwords, no API keys.
//
// FUTURE INTEGRATION (do not enable real payments before the business
// approves payment methods, accounting rules and a provider):
//   1. Move payment records to the backend next to the reservation table and
//      associate them with the same reservationId.
//   2. Verify every payment result SERVER-SIDE with the provider's trusted
//      confirmation (webhook / server API) — never because a button was
//      clicked in the browser.
//   3. Record transaction reference, amount, date and status; protect
//      admin-only payment actions with server-side authorization.
//   4. Delete the simulate buttons and the whole test store.
// =====================================================
(function(){
  "use strict";

  /* ---------------- CONFIG ---------------- */
  const PAYMENT_TEST_MODE = true;                       // simulated payments only
  const REQUIRED_DEPOSIT  = 2000;                       // ₱ per Booking & Reservation guideline #1
  const PAY_STATUS = {
    AWAITING:   "Awaiting Payment",
    PROCESSING: "Payment Processing",
    PAID:       "Paid",
    FAILED:     "Payment Failed"
  };
  // Test records are stored SEPARATELY from any future real payment records.
  const TEST_STORE_KEY = "pdr_payments_test";
  const LIVE_STORE_KEY = "pdr_payments";   // reserved for real records (unused while TEST MODE is on)
  // Shared with booking-status.js — {id, pin} verified on THIS tab only.
  const CTX_KEY = "pdr_verified_booking";

  const esc = pdrEscape;

  /* ---------------- STATE ---------------- */
  let reservation = null;          // verified reservation (customer view, no PIN)

  /* ---------------- HELPERS ---------------- */
  const has = v => v !== undefined && v !== null && String(v).trim() !== "";
  const money = n => "₱" + Number(n).toLocaleString("en-PH", {minimumFractionDigits:2, maximumFractionDigits:2});
  const totalKnown = r => r && r.estimatedTotal !== undefined && r.estimatedTotal !== null && r.estimatedTotal !== "" && isFinite(Number(r.estimatedTotal));
  function fmtDay(v){
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v || "");
    if(!m) return has(v) ? esc(v) : "—";
    return new Date(+m[1], +m[2]-1, +m[3]).toLocaleDateString("en-US", {month:"long", day:"numeric", year:"numeric"});
  }
  const fmtTime = v => has(v) ? (esc(fmtEventTime(v)) || "—") : "—";
  const row = (label, html) => `<div class="pay-row"><span class="pay-row-label">${label}</span><span class="pay-row-value">${html}</span></div>`;
  const textRow = (label, v) => row(label, has(v) ? esc(v) : "—");

  function extrasList(list){
    if(!Array.isArray(list) || !list.length) return "None";
    return `<ul class="pay-services">${list.map(s=>{
      const name = typeof s === "string" ? s : s && s.name;
      const qty  = s && s.quantity > 1 ? ` × ${esc(s.quantity)}` : "";
      return has(name) ? `<li>${esc(name)}${qty}</li>` : "";
    }).join("")}</ul>`;
  }

  function payBadge(status){
    const cls = {
      "Awaiting Payment":"pay-badge-awaiting",
      "Payment Processing":"pay-badge-processing",
      "Paid":"pay-badge-paid",
      "Payment Failed":"pay-badge-failed"
    }[status] || "pay-badge-awaiting";
    return `<span class="pay-badge ${cls}">${esc(status)}</span>`;
  }
  function resBadge(status){
    const cls = status === "Confirmed" ? "status-confirmed" : (status === "Pending" ? "status-pending" : "status-unknown");
    return `<span class="status-badge ${cls}"><span class="dot" aria-hidden="true"></span><span class="status-text">${esc(has(status) ? status : "Unknown")}</span></span>`;
  }

  /* ---------------- VERIFIED BOOKING CONTEXT (this tab only) ---------------- */
  function readCtx(){
    try{ return JSON.parse(sessionStorage.getItem(CTX_KEY) || "null"); }catch(e){ return null; }
  }
  function saveCtx(id, pin){
    try{ sessionStorage.setItem(CTX_KEY, JSON.stringify({id:id, pin:pin})); }catch(e){}
  }
  function clearCtx(){ try{ sessionStorage.removeItem(CTX_KEY); }catch(e){} }

  /* ---------------- PAYMENT RECORDS (test store — one per reservation) ---------------- */
  function storeKey(){ return PAYMENT_TEST_MODE ? TEST_STORE_KEY : LIVE_STORE_KEY; }
  function readPayments(){
    try{ const v = JSON.parse(localStorage.getItem(storeKey()) || "[]"); return Array.isArray(v) ? v : []; }
    catch(e){ return []; }
  }
  function getPayment(resId){
    return readPayments().find(p => p && p.reservationId === resId) || null;
  }
  // UPSERT keyed by reservationId → refreshing or re-simulating NEVER creates
  // a duplicate payment record, and one reservation can never read another
  // reservation's payment data.
  function saveTestPayment(resId, patch){
    const list = readPayments();
    const i = list.findIndex(p => p && p.reservationId === resId);
    const now = new Date().toISOString();
    let rec = i >= 0 ? list[i] : {
      reservationId: resId,
      status: PAY_STATUS.AWAITING,
      amount: REQUIRED_DEPOSIT,
      method: "",
      simulated: PAYMENT_TEST_MODE,
      createdAt: now,
      history: []
    };
    rec = Object.assign(rec, patch, { updatedAt: now, simulated: PAYMENT_TEST_MODE });
    rec.history = (Array.isArray(rec.history) ? rec.history : []).concat([{ status: rec.status, at: now }]);
    if(i >= 0) list[i] = rec; else list.push(rec);
    try{ localStorage.setItem(storeKey(), JSON.stringify(list)); }catch(e){ /* storage full/blocked */ }
    return rec;
  }
  function currentPaymentStatus(resId){
    const rec = getPayment(resId);
    return rec && rec.status ? rec.status : PAY_STATUS.AWAITING;
  }

  /* ---------------- VIEW ROUTING ---------------- */
  const $ = id => document.getElementById(id);
  function showOnly(which){
    $("payVerifyCard").hidden = which !== "verify";
    $("payNoAccess").hidden   = which !== "noaccess";
    $("payPending").hidden    = which !== "pending";
    $("payRoot").hidden       = which !== "root";
  }
  function setVerifyError(msg){ $("payVerifyError").textContent = msg || ""; }

  function reasonMessage(result){
    if(result && result.reason === "TOO_MANY_ATTEMPTS"){
      return `Too many failed attempts. Please wait ${result.retryAfterSeconds || 120} seconds before trying again.`;
    }
    if(result && result.reason === "NOT_FOUND"){
      return "No reservation found. Please check your Reservation ID and Booking PIN.";
    }
    return "Sorry, we could not verify your reservation right now. Please try again.";
  }

  // The ONLY way onto the payment screen: verify ID + PIN against the trusted
  // store and read the reservation's current status from that same source.
  async function verify(id, pin){
    let result;
    try{ result = await findReservation(id, pin); }
    catch(e){ result = { ok:false, reason:"NETWORK" }; }
    if(!result.ok) return { ok:false, result:result };
    return { ok:true, reservation: result.reservation };
  }

  function route(reservationData){
    if(reservationData && reservationData.status === "Confirmed"){
      reservation = reservationData;
      renderReservationInfo();
      refreshPaymentView();
      showOnly("root");
    }else{
      // Pending (or any status that is not Confirmed): NO payment details.
      reservation = null;
      showOnly("pending");
    }
  }

  /* ---------------- RENDERING ---------------- */
  function renderGuidelines(){
    // Exact, unmodified policy text from the shared `guidelines` data in
    // services.js (Booking & Reservation group — all six rules).
    const group = (typeof guidelines !== "undefined" && Array.isArray(guidelines))
      ? guidelines.find(g => g && g.heading === "Booking & Reservation")
      : null;
    const list = $("payGuidelinesList");
    if(!group || !group.items || !group.items.length){
      list.innerHTML = `<li>Guidelines will be shown here once available.</li>`;
      return;
    }
    list.innerHTML = group.items.map(item => `<li>${esc(item)}</li>`).join("");
  }

  function renderReservationInfo(){
    const r = reservation;
    const payStatus = currentPaymentStatus(r.reservationId);
    $("payReservationRows").innerHTML = `
      ${textRow("Reservation ID", r.reservationId)}
      ${textRow("Customer Name", r.customerName)}
      ${row("Event Date", fmtDay(r.eventDate))}
      ${row("Event Time", fmtTime(r.eventTime))}
      ${textRow("Event Type", r.eventType)}
      ${textRow("Main Service", r.mainService)}
      ${textRow("Selected Package", r.selectedPackage)}
      ${r.mainCourses && r.mainCourses.length ? textRow("Main Courses", r.mainCourses.join(", ")) : ""}
      ${row("Additional Services", extrasList(r.additionalServices))}
      ${row("Number of Guests", has(r.guests) ? esc(r.guests) + " pax" : "—")}
      ${row("Reservation Status", resBadge(r.status))}
      ${row("Payment Status", payBadge(payStatus))}`;
  }

  function renderSummary(){
    const r = reservation;
    const payStatus = currentPaymentStatus(r.reservationId);
    const paid = payStatus === PAY_STATUS.PAID;
    const known = totalKnown(r);
    const total = known ? Number(r.estimatedTotal) : null;

    let html = `
      ${row("Estimated Total Bill", known ? money(total) : `<span class="pay-tbd">To be confirmed by staff</span>`)}
      ${row("Required Reservation Deposit", money(REQUIRED_DEPOSIT))}
      ${row("Deposit Status", payBadge(payStatus))}`;

    if(paid){
      html += row("Less Deposit Paid", `<span class="pay-deduct">− ${money(REQUIRED_DEPOSIT)}</span>`);
      html += row("Remaining Estimated Balance",
        known ? `<strong>${money(total - REQUIRED_DEPOSIT)}</strong>` : `<span class="pay-tbd">To be confirmed by staff</span>`);
    }

    // Payment milestones from the published guidelines. The exact accounting
    // treatment of the 50% payments is NOT yet confirmed by the business, so
    // they are shown as placeholders instead of invented amounts.
    html += row("50% Partial Payment<br><small class='pay-sub'>At least 2 weeks before the event</small>",
      `<span class="pay-tbd">To be confirmed by staff</span>`);
    html += row("Remaining 50% Payment<br><small class='pay-sub'>1 day before the event</small>",
      `<span class="pay-tbd">To be confirmed by staff</span>`);
    html += row("Additional / Incidental Charges<br><small class='pay-sub'>Settled on the day of the event</small>",
      `<span class="pay-tbd">To be confirmed by staff</span>`);

    $("paySummaryRows").innerHTML = html;
  }

  function renderTestPanel(){
    if(!PAYMENT_TEST_MODE){ $("payTestCard").hidden = true; return; } // simulate buttons exist ONLY in test mode
    const r = reservation;
    const payStatus = currentPaymentStatus(r.reservationId);
    const rec = getPayment(r.reservationId);
    $("payTestRows").innerHTML = `
      ${textRow("Reservation ID", r.reservationId)}
      ${row("Required Deposit", money(REQUIRED_DEPOSIT))}
      ${row("Payment Status", payBadge(payStatus))}
      ${rec && rec.method ? textRow("Selected Method", rec.method) : ""}
      ${rec && rec.updatedAt ? textRow("Last Updated", new Date(rec.updatedAt).toLocaleString("en-US")) : ""}`;
    $("payTestCard").hidden = false;
  }

  function refreshPaymentView(){
    renderReservationInfo();
    renderSummary();
    renderTestPanel();
    // Restore the chosen method (if any) without touching the payment record.
    const rec = reservation ? getPayment(reservation.reservationId) : null;
    const chosen = rec && rec.method ? rec.method : "";
    document.querySelectorAll('input[name="payMethod"]').forEach(rb=>{ rb.checked = rb.value === chosen; });
    if(chosen){
      $("paySelectedMethod").hidden = false;
      $("paySelectedMethod").textContent = `Selected payment method: ${chosen} (placeholder — pending business approval)`;
    }else{
      $("paySelectedMethod").hidden = true;
    }
  }

  function showResult(kind){
    const box = $("payResult");
    box.hidden = false;
    if(kind === "success"){
      box.className = "pay-result pay-result-ok";
      box.innerHTML = `
        <p class="pay-result-title">PAYMENT TEST RESULT</p>
        <p class="pay-result-status"><strong>Status: Test Payment Successful</strong></p>
        <p>This is a simulated payment.<br>No actual money was transferred.</p>`;
    }else{
      box.className = "pay-result pay-result-fail";
      box.innerHTML = `
        <p class="pay-result-title">PAYMENT TEST RESULT</p>
        <p class="pay-result-status"><strong>Status: Payment Failed</strong></p>
        <p>No payment was recorded.<br>Please try again or contact the restaurant.</p>`;
    }
  }

  /* ---------------- EVENTS ---------------- */
  function bindVerifyForm(){
    $("payVerifyForm").addEventListener("submit", async ev=>{
      ev.preventDefault();
      const id  = $("payResId").value.trim();
      const pin = $("payResPin").value.trim();
      setVerifyError("");
      if(!id){ setVerifyError("Please enter your Reservation ID."); return; }
      if(!pin){ setVerifyError("Please enter your 6-digit Booking PIN."); return; }

      const btn = $("payVerifyBtn");
      btn.disabled = true; btn.textContent = "Verifying…";
      const out = await verify(id, pin);
      btn.disabled = false; btn.textContent = "Verify Reservation";

      if(!out.ok){
        if(out.result && out.result.reason === "NOT_FOUND") clearCtx();
        setVerifyError(reasonMessage(out.result));
        return;
      }
      saveCtx(id, pin);
      setVerifyError("");
      route(out.reservation);
      window.scrollTo({top:0, behavior:"smooth"});
    });
  }

  function bindMethodForm(){
    $("payMethodForm").addEventListener("submit", ev=>{
      ev.preventDefault();
      const chosen = document.querySelector('input[name="payMethod"]:checked');
      if(!chosen){ $("payMethodError").textContent = "Please select a payment method."; return; }
      $("payMethodError").textContent = "";
      if(reservation) saveTestPayment(reservation.reservationId, { method: chosen.value });
      refreshPaymentView();
      $("paySelectedMethod").hidden = false;
      $("paySelectedMethod").textContent = `Selected payment method: ${chosen.value} (placeholder — pending business approval)`;
      $("payTestCard").scrollIntoView({behavior:"smooth", block:"start"});
    });
    document.querySelectorAll('input[name="payMethod"]').forEach(rb=>{
      rb.addEventListener("change", ()=>{ $("payMethodError").textContent = ""; });
    });
  }

  function bindTestButtons(){
    // TEST MODE ONLY — these buttons are hidden entirely when
    // PAYMENT_TEST_MODE is false. They simulate results; they never move money.
    $("simSuccessBtn").addEventListener("click", ()=>{
      if(!reservation) return;
      saveTestPayment(reservation.reservationId, {
        status: PAY_STATUS.PAID,
        amount: REQUIRED_DEPOSIT,
        method: (document.querySelector('input[name="payMethod"]:checked') || {}).value || (getPayment(reservation.reservationId) || {}).method || "",
        paidAt: new Date().toISOString()
      });
      showResult("success");
      refreshPaymentView();
    });

    $("simFailBtn").addEventListener("click", ()=>{
      if(!reservation) return;
      // A FAILED simulation must never mark the payment as Paid.
      saveTestPayment(reservation.reservationId, { status: PAY_STATUS.FAILED, amount: REQUIRED_DEPOSIT });
      showResult("fail");
      refreshPaymentView();
    });

    $("simCancelBtn").addEventListener("click", ()=>{
      // Clears the on-screen test result and the chosen method only.
      // No stored payment record and no reservation is changed.
      $("payResult").hidden = true;
      $("payResult").className = "pay-result";
      document.querySelectorAll('input[name="payMethod"]').forEach(rb=>{ rb.checked = false; });
      if(reservation){
        const rec = getPayment(reservation.reservationId);
        if(rec && rec.method){ saveTestPayment(reservation.reservationId, { method: "" }); }
      }
      $("paySelectedMethod").hidden = true;
      refreshPaymentView();
    });
  }

  function bindNav(){
    const toggle = $("navToggle"), links = $("navLinks");
    toggle.addEventListener("click", ()=>{
      const open = links.classList.toggle("open");
      toggle.classList.toggle("open", open);
      toggle.setAttribute("aria-expanded", open);
    });
    const header = $("site-header");
    const onScroll = ()=>header.classList.toggle("scrolled", window.scrollY > 10);
    window.addEventListener("scroll", onScroll); onScroll();
  }

  /* ---------------- INIT ---------------- */
  async function init(){
    bindNav();
    renderGuidelines();
    bindVerifyForm();
    bindMethodForm();
    bindTestButtons();

    // ?id= only PREFILLS the form — it never grants access by itself.
    const idParam = new URLSearchParams(location.search).get("id");
    if(idParam && !$("payResId").value) $("payResId").value = idParam;

    const ctx = readCtx();
    if(ctx){
      const out = await verify(ctx.id, ctx.pin);
      if(out.ok){ setVerifyError(""); route(out.reservation); return; }
      const reason = out.result && out.result.reason;
      if(reason === "NOT_FOUND"){
        clearCtx();                     // the booking no longer verifies — start over
        showOnly("verify");
        return;
      }
      // Rate limit or temporary failure — keep the session and explain.
      showOnly("verify");
      setVerifyError(reasonMessage(out.result));
      return;
    }
    showOnly("verify");

    // Refreshes re-verify everything: a reservation demoted back to Pending
    // immediately loses its payment screen, and refreshing never duplicates
    // a payment record (records are upserted by reservationId).
    window.addEventListener("pageshow", ()=>{
      if(reservation && !document.getElementById("payRoot").hidden){
        verify((readCtx()||{}).id, (readCtx()||{}).pin).then(out=>{
          if(out.ok) route(out.reservation);
          else { reservation = null; clearCtx(); showOnly("verify"); }
        });
      }
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
