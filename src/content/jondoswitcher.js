const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;
Cu.import('resource://gre/modules/Services.jsm');
Cu.import("resource://jondoswitcher/content/jondo-singletons.js");
var windowMediator = Cc["@mozilla.org/appshell/window-mediator;1"].getService(Ci.nsIWindowMediator);

var checkProxyTimerObj = null;

// add onload listener
window.addEventListener("load", function jondo_onload() {
    // remove onload event listener
    window.removeEventListener("load", jondo_onload, false);

    // initialize JonDoSwitcher
    JonDoSwitcher.init();
    checkProxyTimerObj = setInterval(checkProxy, 1000);

    // add event listeners for messages
    window.addEventListener("Jondo-New-Identity", sendSwitchCascadeCommand, false);
}, false);

// add onunload listener
window.addEventListener("unload", function jondo_onunload() {
    // remove onload event listener
    window.removeEventListener("unload", jondo_onunload, false);

    // remove event listeners for messages
    window.removeEventListener("Jondo-New-Identity", sendSwitchCascadeCommand, false);
}, false);



// check which proxy is used once every 1 second
function checkProxy(){
    var proxy = JonDoSwitcher.getProxy();
    if(proxy == "JonDo"){
        window.top.document.getElementById("enableJonDo").style.display = "none";
        window.top.document.getElementById("jondo-switcher-message").value = JonDoSwitcher.stringsBundle.GetStringFromName("connectedToJondo") + "   ";
        // start socket connecting
        JonDoCommunicator.startSocketConnecting();
    }else if(proxy == "Tor"){
        window.top.document.getElementById("enableTor").style.display = "none";
        window.top.document.getElementById("jondo-switcher-message").value = JonDoSwitcher.stringsBundle.GetStringFromName("connectedToTor") + "   ";        
    }else if(proxy == "Direct"){
        window.top.document.getElementById("disableAllProxies").style.display = "none";
        window.top.document.getElementById("jondo-switcher-message").value = JonDoSwitcher.stringsBundle.GetStringFromName("connectedDirectly") + "   ";        
    }
    if(proxy != "Unknown"){
        clearInterval(checkProxyTimerObj);
        checkProxyTimerObj = null;
    }
}


// UI responses
var enableJonDo = () => {JonDoSwitcher.enableJonDo();};
var enableTor = () => {JonDoSwitcher.enableTor();};
var disableAllProxies = () => {JonDoSwitcher.disableAllProxies();};
var sendSwitchCascadeCommand = () => {
    try{
        if(windowMediator.getMostRecentWindow("navigator:browser") == window){
            JonDoCommunicator.sendSwitchCascadeCommand();
        }else{
            alert("not current window");
        }
    }catch(e){
        alert(e);
    }
}