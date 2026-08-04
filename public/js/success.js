(() => {
  "use strict";

  const params=new URLSearchParams(window.location.search);
  const sessionId=params.get("session_id");
  const summary=document.getElementById("summary");
  const message=document.getElementById("message");

  const fields={
    plan:document.getElementById("plan"),
    username:document.getElementById("username"),
    password:document.getElementById("password"),
    expires:document.getElementById("expires"),
    status:document.getElementById("wifi-status")
  };

  document.querySelectorAll("[data-copy]").forEach(button=>{
    button.addEventListener("click",async()=>{
      const field=fields[button.dataset.copy];
      const original=button.textContent;
      const copied=await TechCPR.copyText(field?.textContent || "");
      button.textContent=copied?"Copied":"Copy failed";
      setTimeout(()=>button.textContent=original,1500);
    });
  });

  if(!sessionId){
    fail("Missing Stripe session ID.");
    return;
  }

  loadPurchase(0);

  async function loadPurchase(attempt){
    try{
      const response=await fetch(`/api/purchase/${encodeURIComponent(sessionId)}`,{
        cache:"no-store"
      });
      const data=await response.json();

      if(response.status===404 && attempt<12){
        summary.textContent="Payment received. Preparing your WiFi account…";
        setTimeout(()=>loadPurchase(attempt+1),1500);
        return;
      }

      if(!response.ok){
        throw new Error(data.error || "Unable to retrieve your WiFi account.");
      }

      fields.plan.textContent=data.plan || "WiFi Access";
      fields.username.textContent=data.username || "Unavailable";
      fields.password.textContent=data.password || "Unavailable";
      fields.expires.textContent=TechCPR.formatDate(data.expires);
      fields.status.textContent=data.wifi_status || "Pending";

      summary.textContent=
        data.wifi_status==="Active"
          ?"Your WiFi access is ready."
          :`Account status: ${data.wifi_status || "Pending"}`;

      TechCPR.setMessage(message,"Keep these credentials available until your access period ends.");
    }catch(error){
      fail(error.message || "Unable to load your account.");
    }
  }

  function fail(text){
    summary.textContent="We could not finish displaying your account.";
    TechCPR.setMessage(
      message,
      `${text} Contact TechCPRSupport@gmail.com for assistance.`,
      "error"
    );
  }
})();
