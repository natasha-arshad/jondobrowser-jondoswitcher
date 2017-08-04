const {classes: Cc, interfaces: Ci, utils: Cu} = Components;
Cu.import('resource://gre/modules/Services.jsm');
Cu.import("resource://gre/modules/AddonManager.jsm");
Cu.import("resource://gre/modules/NetUtil.jsm");
Cu.import("resource://gre/modules/FileUtils.jsm");

let prefsService = Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefService);
var stringBundleService = Cc["@mozilla.org/intl/stringbundle;1"].getService(Ci.nsIStringBundleService);
var toolkitProfileService = Cc["@mozilla.org/toolkit/profile-service;1"].createInstance(Ci.nsIToolkitProfileService);
var xreService = Cc["@mozilla.org/xre/app-info;1"].getService(Ci.nsIXULRuntime);

var switcherInitCount = 0;

var curNetwork = 0;                     //0: direct, 1: jondo, 2: tor
var jondoEnabled = false;
var jondoChecked = false;
var torEnabled = false;
var torChecked = false;

var dontAskTorToggling = false;         //update through Tor
var updateDialogShown = false;

var stringsBundle = 0;                  //string bundle object
var xpiSrcDir = null, xpiDestDir = null;//xpi copying locations
var extTxtDir = null;                   //for printing extension directory in OSX

// run jondo_switcher_load on browser load
// initialization for switcher ui
window.addEventListener("load", function jondo_switcher_load() {
    //remove onload listener
    window.removeEventListener("load", jondo_switcher_load, false);
    //reset no_proxies_on to ""
    try{
        if(prefsService){
            let prefsBranch = prefsService.getBranch("network.proxy.");
            if (prefsBranch) {
                prefsBranch.setCharPref("no_proxies_on", "");
            }
        }
    }catch (e){
    }

    //multi-language strings bundle
    stringsBundle = stringBundleService.createBundle("chrome://jondoswitcher/locale/jondoswitcher.properties");

    //if this is the first time loading, initialize once
    if(switcherInitCount == 0){       
        //init update intercepter
        JondoUpdateIntercepter.init();
        try{
            //check if jondo addons are enabled
            AddonManager.getAddonByID("jondo-launcher@jondos.de", function(addon) {
                if (addon) {
                    jondoEnabled = !(addon.userDisabled);
                }else{
                    jondoEnabled = false;
                }
                jondoChecked = true;
                if(torChecked){
                    validateCurrentNetwork();
                }
            });
            
            //check if tor addons are enabled
            AddonManager.getAddonByID("torbutton@torproject.org", function(addon) {
                if (addon) {
                    torEnabled = !(addon.userDisabled);
                }else{
                    torEnabled = false;
                }
                torChecked = true;
                if(jondoChecked){
                    validateCurrentNetwork();
                }
            });
        }catch(e){
            alert(e);
        }
    }
    switcherInitCount = 1;
}, false);

//validate current network preferences with enabled addons
//switch addons if necessary
function validateCurrentNetwork(){
    //if this is the first launch after install, turn on jondo
    try{
        //initialize xpi paths
        getXpiPaths();
        if(prefsService){
            let prefsBranch = prefsService.getBranch("extensions.jondoswitcher.");
            if(prefsBranch){
                if(prefsBranch.getIntPref("is_first_launch") == 1){
                    prefsBranch.setIntPref("is_first_launch", 0);
                    if(!jondoEnabled && !torEnabled){
                        switchAddons(true, false);
                        restart();
                        return;
                    }
                }
            }
        }
    }catch(e){
        alert(e);
    }

    //create extensionsDir.txt file that contains extensions directory path
    try{
        var mOS = xreService.OS; 
        var txtFile = null;
        //for osx, print to JonDoBrowser-Data/extensionsDir.txt
        if(mOS == "Darwin"){
            txtFile = extTxtDir.clone();
            txtFile = txtFile.parent;
            txtFile = txtFile.parent;
            txtFile = txtFile.parent;
        }
        //for win/linux, print to JonDo/extensionsDir.txt
        else{
            txtFile = xpiSrcDir.clone();
        }
        txtFile.appendRelativePath("extensionsDir.txt");
        writeToExtensionDirFile(txtFile, xpiDestDir.path);
    }catch(e){
        alert(e);
    }
    
    //if both are enabled, disable tor and restart
    if(jondoEnabled && torEnabled){
        alert("JonDo launch Error!\nPlease restart JonDoBrowser to fix this error.");
        switchAddons(true, false);
        restart();
        return;
    }
    //if only jondo is enabled
    if(jondoEnabled){
        window.top.document.getElementById("enableJonDo").style.display = "none";
        window.top.document.getElementById("jondo-switcher-message").value = stringsBundle.GetStringFromName("connectedToJondo") + "   ";
        curNetwork = 1;
        cloneProxySettings("extensions.jondoswitcher.jondobutton.", "network.proxy.");
        return;
    }
    //if only tor is enabled
    if (torEnabled) {
        window.top.document.getElementById("enableTor").style.display = "none";
        window.top.document.getElementById("jondo-switcher-message").value = stringsBundle.GetStringFromName("connectedToTor") + "   ";
        curNetwork = 2;
        cloneProxySettings("extensions.jondoswitcher.torbutton.", "network.proxy.");
        return;
    }
    //if both are disabled
    if(!jondoEnabled && !torEnabled){
        window.top.document.getElementById("disableAllProxies").style.display = "none";
        window.top.document.getElementById("jondo-switcher-message").value = stringsBundle.GetStringFromName("connectedDirectly") + "   ";
        cloneProxySettings("extensions.jondoswitcher.direct.", "network.proxy.");
        //if tor is temporarily turned off during update donwload
        //turn it back on
        try{
            if(prefsService){
                let prefsBranch = prefsService.getBranch("extensions.jondoswitcher.");
                if (prefsBranch) {
                    let currentNetwork = prefsBranch.getCharPref("current_network");
                    let updateStatus = prefsBranch.getIntPref("update_status");
                    if(currentNetwork == "tor" && updateStatus == 1){
                        setUpdateStatus(0);
                        switchAddons(false, true);
                        continueUpdates();
                    }
                }
            }
        }catch(e){
            alert(e);
        }
    }
}

//continue to update on browser
//called when browser switches from direct connection to tor network for update
function continueUpdates() {
    let updateMgr = Cc["@mozilla.org/updates/update-manager;1"].getService(Ci.nsIUpdateManager);
    let update = updateMgr.activeUpdate;
    let updateState = (update) ? update.state : undefined;
    let pendingStates = [ "pending", "pending-service",
                          "applied", "applied-service" ];
    let isPending = (updateState && (pendingStates.indexOf(updateState) >= 0));

    let prompter = Cc["@mozilla.org/updates/update-prompt;1"].createInstance(Ci.nsIUpdatePrompt);
    if (isPending)
        prompter.showUpdateDownloaded(update, false);
    else
        prompter.checkForUpdates();
}



//flag1 : enable jondo
//flag2 : enable tor
function switchAddons(flag1, flag2){
    // turn on jondobutton & jondolauncher only for jondo-network
    AddonManager.getAddonByID("info@jondos.de", function(addon) {
        if (!addon) return;
        // only jondo is enabled
        if(flag1 && !flag2){
            addon.userDisabled = false;
        }
        // only tor is enabled
        else if(!flag1 && flag2){
            addon.userDisabled = true;
        }
        // direct connection : exception : enable jondobutton only
        else{
            addon.userDisabled = false;   
        }
    });
    AddonManager.getAddonByID("jondo-launcher@jondos.de", function(addon) {
        if (!addon) return;
        addon.userDisabled = !flag1;
    });
    // turn on torbutton & torlauncher only for tor-network
    AddonManager.getAddonByID("torbutton@torproject.org", function(addon) {
        if (!addon) return;
        addon.userDisabled = !flag2;
    });
    AddonManager.getAddonByID("tor-launcher@torproject.org", function(addon) {
        if (!addon) return;
        addon.userDisabled = !flag2;
    });

    // addons copying
    if(xpiSrcDir != null && xpiSrcDir.exists() && 
       xpiDestDir != null && xpiDestDir.exists()){
        // if jondo is enabled, jondobutton & jondolauncher are copied to extension directory
        if(flag1){
            let fileJonDoButton = xpiSrcDir.clone(); fileJonDoButton.appendRelativePath("info@jondos.de.xpi");
            let fileJonDoLauncher = xpiSrcDir.clone(); fileJonDoLauncher.appendRelativePath("jondo-launcher@jondos.de.xpi");
            try{
                if(fileJonDoButton.exists()){
                    fileJonDoButton.copyTo(xpiDestDir, "");
                }
                if(fileJonDoLauncher.exists()){
                    fileJonDoLauncher.copyTo(xpiDestDir, "");
                }
            }catch(e){

            }
        } 
        // if tor is enabled, torbutton & torlauncher are copied to extension directory
        else if(flag2){
            let fileTorButton = xpiSrcDir.clone(); fileTorButton.appendRelativePath("torbutton@torproject.org.xpi");
            let fileTorLauncher = xpiSrcDir.clone(); fileTorLauncher.appendRelativePath("tor-launcher@torproject.org.xpi");
            try{
                if(fileTorButton.exists()){
                    fileTorButton.copyTo(xpiDestDir, "");
                }
                if(fileTorLauncher.exists()){
                    fileTorLauncher.copyTo(xpiDestDir, "");
                }
            }catch(e){

            }
        }
        // if connection is direct, jondobutton is copied
        else {
            let fileJonDoButton = xpiSrcDir.clone(); fileJonDoButton.appendRelativePath("info@jondos.de.xpi");
            try{
                if(fileJonDoButton.exists()){
                    fileJonDoButton.copyTo(xpiDestDir, "");
                }
            }catch(e){

            }
        } 
    }

    // set preferences so that socks proxy is not enforced except for tor,
    // in which case, socks proxy will be turned on by torbutton after restart
    try{
        if (prefsService)
        {
            prefsBranch = prefsService.getBranch("network.proxy.");
            if (prefsBranch)
            {
                prefsBranch.setCharPref("socks", "");
                prefsBranch.setIntPref("socks_port", 0);
                prefsBranch.setBoolPref("socks_remote_dns", false);
            }    
        }
    } catch (e) {}
    
    //set environment variable
    try{
        var env = Cc["@mozilla.org/process/environment;1"].getService(Ci.nsIEnvironment);
        if (flag1 && !flag2) {
            env.set("JONDO_NETWORK", "jondo");
        } else if (!flag1 && flag2) {
            env.set("JONDO_NETWORK", "tor");
        } else {
            env.set("JONDO_NETWORK", "direct");
        }        
    } catch (e) {}
}

function enableJonDo(){
    if(curNetwork == 1) return;
    if(window.confirm(stringsBundle.GetStringFromName("browserRestartAlert1") + "\n" + stringsBundle.GetStringFromName("browserRestartAlert2")) == false) return;
    //backup whatever proxy settings the browser currently has and restore.
    if(curNetwork == 0){
        cloneProxySettings("network.proxy.", "extensions.jondoswitcher.direct.");
    }
    cloneProxySettings("extensions.jondoswitcher.jondobutton.", "network.proxy.");
    setCurrentNetwork("jondo");
    switchAddons(true, false);
    changeHomePage("about:tor");
    restart();
}

function enableTor(){
    if(curNetwork == 2) return;
    if(window.confirm(stringsBundle.GetStringFromName("browserRestartAlert1") + "\n" + stringsBundle.GetStringFromName("browserRestartAlert2")) == false) return;
    //backup whatever proxy settings the browser currently has and restore.
    if(curNetwork == 0){
        cloneProxySettings("network.proxy.", "extensions.jondoswitcher.direct.");
    }
    cloneProxySettings("extensions.jondoswitcher.torbutton.", "network.proxy.");
    setCurrentNetwork("tor");
    switchAddons(false, true);
    changeHomePage("about:tor");
    restart();
}

function disableAllProxies(){
    if(curNetwork == 0) return;
    if(window.confirm(stringsBundle.GetStringFromName("browserRestartAlert1") + "\n" + stringsBundle.GetStringFromName("browserRestartAlert2")) == false) return;
    //restore proxy settings set by user
    cloneProxySettings("extensions.jondoswitcher.direct.", "network.proxy.");
    setCurrentNetwork("direct");
    switchAddons(false, false);
    changeHomePage("about:noproxy");
    restart();
}

function setCurrentNetwork(networkString){
    try{
        if (prefsService)
        {
            let prefsBranch = prefsService.getBranch("extensions.jondoswitcher.");
            if (prefsBranch) {
                prefsBranch.setCharPref("current_network", networkString);
            }
        }
    }catch(e){
        alert(e);
    }
}
function setUpdateStatus(updateStatus){
    try{
        if (prefsService)
        {
            let prefsBranch = prefsService.getBranch("extensions.jondoswitcher.");
            if (prefsBranch) {
                prefsBranch.setIntPref("update_status", updateStatus);
            }
        }
    }catch(e){
        alert(e);
    }
}

function restart() {
    try{
      let canceled = Cc["@mozilla.org/supports-PRBool;1"].createInstance(Ci.nsISupportsPRBool);
      Services.obs.notifyObservers(canceled, "quit-application-requested", "restart");
      if (canceled.data) return false; // somebody canceled our quit request
      // restart
      Cc['@mozilla.org/toolkit/app-startup;1'].getService(Ci.nsIAppStartup).quit(Ci.nsIAppStartup.eAttemptQuit | Ci.nsIAppStartup.eRestart);

      return true;
    }catch (e){}
}

var JondoUpdateIntercepter = {
   observerService : null,

   init : function() {
      JondoUpdateIntercepter.observerService = Cc["@mozilla.org/observer-service;1"].getService(Ci.nsIObserverService);
      JondoUpdateIntercepter.observerService.addObserver(JondoUpdateIntercepter.observerResponseHandler, 'http-on-examine-response', false);
      JondoUpdateIntercepter.observerService.addObserver(JondoUpdateIntercepter.observerResponseHandler, 'http-on-examine-cached-response', false);
   },

   uninit : function() {
      JondoUpdateIntercepter.observerService.removeObserver(JondoUpdateIntercepter.observerResponseHandler, 'http-on-examine-response', false);
      JondoUpdateIntercepter.observerService.removeObserver(JondoUpdateIntercepter.observerResponseHandler, 'http-on-examine-cached-response', false);
   },

   observerResponseHandler : { observe : function(subject, topic, data) {
      // http interface
      var httpChannel = subject.QueryInterface(Ci.nsIHttpChannel);
      if(httpChannel === null) {
         return;
      }
      //only for jondo update server
      var url = httpChannel.URI.spec;
      if(url.includes("jondobrowser.jondos.de/alpha/") || 
        url.includes("jondobrowser.jondos.de/beta/") || 
        url.includes("jondobrowser.jondos.de/release/")){
        try{
            var contentLength = httpChannel.getResponseHeader('Content-Length');
            if (contentLength){
                contentLength = parseInt(contentLength);
                //if update available
                if(contentLength > 100){
                    if(jondoEnabled){
                        //set no_proxies_on for jondo update server
                        try{
                            if (prefsService)
                            {
                                prefsBranch = prefsService.getBranch("network.proxy.");
                                if (prefsBranch)
                                {
                                    prefsBranch.setCharPref("no_proxies_on", "jondobrowser.jondos.de");
                                }
                            }
                        }catch(e){}
                    }else if(torEnabled && !dontAskTorToggling && !updateDialogShown){
                        updateDialogShown = true;
                        var params = {inn:null, out:""};
                        window.openDialog("chrome://jondoswitcher/content/jondo-update-dialog.xul", "",
                            "chrome, dialog, modal, resizable=no, centerscreen", params).focus();
                        if(params.out == "ok"){
                            setCurrentNetwork("tor");
                            setUpdateStatus(1);
                            switchAddons(false, false);
                            restart();
                        }else if(params.out == "cancel"){
                            dontAskTorToggling = true;
                        }
                    }
                }
            }
        }catch(e){
            alert(e);
        }
        return;
      }
   }}
};

function cloneProxySettings(srcBranchName, destBranchName){
    try{
        if(prefsService){
            var srcBranch = prefsService.getBranch(srcBranchName);
            var destBranch = prefsService.getBranch(destBranchName);
            destBranch.setIntPref("type", srcBranch.getIntPref("type"));
            destBranch.setCharPref("ssl", srcBranch.getCharPref("ssl"));
            destBranch.setIntPref("ssl_port", srcBranch.getIntPref("ssl_port"));
            destBranch.setCharPref("socks", srcBranch.getCharPref("socks"));
            destBranch.setIntPref("socks_port", srcBranch.getIntPref("socks_port"));
            destBranch.setCharPref("http", srcBranch.getCharPref("http"));
            destBranch.setIntPref("http_port", srcBranch.getIntPref("http_port"));
            destBranch.setCharPref("ftp", srcBranch.getCharPref("ftp"));
            destBranch.setIntPref("ftp_port", srcBranch.getIntPref("ftp_port"));
        }
    } catch(e){
        alert(e);
    }
}

function changeHomePage(homePage){
    try{
        if(prefsService){
            var branch = prefsService.getBranch("browser.startup.");
            branch.setCharPref("homepage", homePage);
        }
    } catch(e){
        alert(e);
    }
}

function writeToExtensionDirFile(file, data){
    // file is nsIFile, data is a string
    var ostream = FileUtils.openSafeFileOutputStream(file);
    var converter = Cc["@mozilla.org/intl/scriptableunicodeconverter"].createInstance(Ci.nsIScriptableUnicodeConverter);
    converter.charset = "UTF-8";
    var istream = converter.convertToInputStream(data);
    // The last argument (the callback) is optional.
    NetUtil.asyncCopy(istream, ostream, function(status) {
        if (!Components.isSuccessCode(status)) {
            // Handle error!
            return;
        }
    });
}

function getXpiPaths(){
    var mOS = xreService.OS;        
    let topDir = Cc["@mozilla.org/file/directory_service;1"].getService(Ci.nsIProperties).get("CurProcD", Ci.nsIFile);
    let appInfo = Cc["@mozilla.org/xre/app-info;1"].getService(Ci.nsIXULAppInfo);
    let tbbBrowserDepth = (mOS == "Darwin") ? 3 : 1;
    if ((appInfo.ID == "{3550f703-e582-4d05-9a08-453d09bdfdc6}") || (appInfo.ID == "{33cb9019-c295-46dd-be21-8c4936574bee}"))
    {
        // On Thunderbird/Instantbird, the topDir is the root dir and not
        // browser/, so we need to iterate one level less than Firefox.
        --tbbBrowserDepth;
    }
    while (tbbBrowserDepth > 0)
    {
        let didRemove = (topDir.leafName != ".");
        topDir = topDir.parent;
        if (didRemove){
            tbbBrowserDepth--;
        }
    }
    // JonDo directory where xpi's are backed up
    xpiSrcDir = topDir.clone();
    // extensions directory where xpi's should be copied
    xpiDestDir = toolkitProfileService.getProfileByName("default").rootDir.clone();
    if(mOS == "WINNT"){
        xpiSrcDir.appendRelativePath("JonDo");
        xpiDestDir.appendRelativePath("extensions");
    }else if(mOS == "Darwin"){
        xpiSrcDir.appendRelativePath("Contents/MacOS/JonDo");
        xpiDestDir.appendRelativePath("extensions");
        extTxtDir = xpiDestDir.clone();
        // special case : /extensions/extensions directory
        let tmpXpiDestDir = xpiDestDir.clone();
        tmpXpiDestDir.appendRelativePath("extensions");
        if(tmpXpiDestDir.exists()){
            xpiDestDir = tmpXpiDestDir;
        }
    }else{
        xpiSrcDir.appendRelativePath("JonDo");
        xpiDestDir.appendRelativePath("extensions");
    }
}