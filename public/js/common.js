(() => {
  "use strict";

  window.TechCPR = Object.freeze({
    setMessage(element,text,type="success"){
      if(!element)return;
      element.textContent=text;
      element.className=`status-message ${type==="error"?"is-error":"is-success"}`;
    },

    formatDate(value){
      if(!value)return "Unavailable";
      const parsed=new Date(value);
      return Number.isNaN(parsed.getTime())?String(value):parsed.toLocaleString();
    },

    async copyText(value){
      if(!value)return false;
      try{
        await navigator.clipboard.writeText(value);
        return true;
      }catch{
        const input=document.createElement("textarea");
        input.value=value;
        input.style.position="fixed";
        input.style.opacity="0";
        document.body.append(input);
        input.select();
        const copied=document.execCommand("copy");
        input.remove();
        return copied;
      }
    }
  });
})();
