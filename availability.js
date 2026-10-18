// =====================================================
// HOMEPAGE AVAILABILITY CALENDAR
// Uses getUnavailableDates() from the BACKEND AREA of services.js — the SAME
// source the booking-page calendars use — so this calendar and every booking page always agree on
// which dates are taken. This widget is read-only: dates are shown, not
// selectable, since booking itself happens on a service page.
// Requires services.js to be loaded first (for getUnavailableDates).
// =====================================================

(function(){
  let avYear, avMonth;
  const today = new Date();
  avYear = today.getFullYear();
  avMonth = today.getMonth();

  function daysInMonth(y,m){ return new Date(y,m+1,0).getDate(); }
  function fmtDate(y,m,d){ return `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`; }

  let takenDates = []; // filled from the backend area (getUnavailableDates in services.js)

  // Draws the calendar from whatever dates we currently know.
  function renderAvailabilityCalendar(){
    const el = document.getElementById("availabilityCalendar");
    if(!el) return; // homepage calendar container not present on this page

    const unavailable = takenDates;
    const first = new Date(avYear, avMonth, 1).getDay();
    const total = daysInMonth(avYear, avMonth);
    const monthName = new Date(avYear, avMonth, 1).toLocaleString('default', {month:'long'});

    let cells = `<div class="dow">Su</div><div class="dow">Mo</div><div class="dow">Tu</div><div class="dow">We</div><div class="dow">Th</div><div class="dow">Fr</div><div class="dow">Sa</div>`;
    for(let i=0;i<first;i++) cells += `<div class="day blank"></div>`;
    const today = getTodayLocalDate(); // Asia/Manila, recalculated on every render
    for(let d=1; d<=total; d++){
      const ds = fmtDate(avYear, avMonth, d);
      if(ds < today){
        // Past dates are never bookable — greyed out and marked disabled.
        cells += `<div class="day past" aria-disabled="true" aria-label="${ds} — past date">${d}</div>`;
        continue;
      }
      const unavail = unavailable.includes(ds);
      const isToday = ds === today;
      cells += `<div class="day ${unavail?'unavail':'avail'}${isToday?' today':''}" tabindex="0" aria-label="${ds}${unavail?' — unavailable':(isToday?' — today, available':' — available')}">${d}</div>`;
    }

    el.innerHTML = `
      <div class="cal-head">
        <button type="button" id="avPrev" aria-label="Previous month">‹</button>
        <span>${monthName} ${avYear}</span>
        <button type="button" id="avNext" aria-label="Next month">›</button>
      </div>
      <div class="cal-grid">${cells}</div>
    `;

    document.getElementById("avPrev").onclick = ()=>{
      avMonth--; if(avMonth<0){avMonth=11; avYear--;}
      renderAvailabilityCalendar();
    };
    document.getElementById("avNext").onclick = ()=>{
      avMonth++; if(avMonth>11){avMonth=0; avYear++;}
      renderAvailabilityCalendar();
    };
  }

  // Fetches the latest taken dates, then redraws.
  async function refreshAvailability(){
    try{ takenDates = await getUnavailableDates(); }catch(e){ /* keep the last known dates */ }
    renderAvailabilityCalendar();
  }

  document.addEventListener("DOMContentLoaded", ()=>{ renderAvailabilityCalendar(); refreshAvailability(); });
  // Refresh when a reservation is saved in another tab (prototype), or when returning via the Back button.
  window.addEventListener("storage", e => { if(e.key === "pdr_reservations") refreshAvailability(); });
  window.addEventListener("pageshow", e => { if(e.persisted) refreshAvailability(); });
})();