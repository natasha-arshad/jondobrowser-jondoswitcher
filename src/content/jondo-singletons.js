'use strict';

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;
Cu.import('resource://gre/modules/Services.jsm');
Cu.import("resource://gre/modules/AddonManager.jsm");
Cu.import("resource://gre/modules/NetUtil.jsm");
Cu.import("resource://gre/modules/FileUtils.jsm");

let prefsService = Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefService);
var stringBundleService = Cc["@mozilla.org/intl/stringbundle;1"].getService(Ci.nsIStringBundleService);
var toolkitProfileService = Cc["@mozilla.org/toolkit/profile-service;1"].createInstance(Ci.nsIToolkitProfileService);
var xreService = Cc["@mozilla.org/xre/app-info;1"].getService(Ci.nsIXULRuntime);
var windowMediator = Cc["@mozilla.org/appshell/window-mediator;1"].getService(Ci.nsIWindowMediator);


var JonDoSwitcher = {
    initialized : false,
    
    curNetwork : -1,                             //0: direct, 1: jondo, 2: tor
    jondoEnabled : false,
    jondoChecked : false,
    torEnabled : false,
    torChecked : false,

    dontAskTorToggling : false,                 //update through Tor
    updateDialogShown : false,

    stringsBundle : 0,                          //string bundle object
    xpiSrcDir : null, xpiDestDir : null,        //xpi copying locations
    extTxtDir : null,                           //for printing extension directory in OSX

    shouldBackupDirectProxyPrefs : true,        //backup proxy settings on shutdown except for the very first shutdown after install

    stringsBundle : 0,

    init : () => {
        // already initizlized
        if(JonDoSwitcher.initialized) {
            return;
        }
        JonDoSwitcher.initialized = true;

        // initialize other singletons
        JonDoNetworkIntercepter.init();
        BrowserShutdownIntercepter.init();

        // multi-language strings bundle
        JonDoSwitcher.stringsBundle = stringBundleService.createBundle("chrome://jondoswitcher/locale/jondoswitcher.properties");

        // determine which proxy is alive by asyncronously checking which addons are enabled
        JonDoSwitcher.getCurrentNetworkAsync();
    },

    getCurrentNetworkAsync : () => {
        // validate current network and update network string
        try{
            //check if jondo addons are enabled
            AddonManager.getAddonByID("jondo-launcher@jondos.de", function(addon) {
                if (addon) {
                    JonDoSwitcher.jondoEnabled = !(addon.userDisabled);
                }else{
                    JonDoSwitcher.jondoEnabled = false;
                }
                JonDoSwitcher.jondoChecked = true;
                if(JonDoSwitcher.torChecked){
                    JonDoSwitcher.validateCurrentNetwork();
                }
            });
            
            //check if tor addons are enabled
            AddonManager.getAddonByID("torbutton@torproject.org", function(addon) {
                if (addon) {
                    JonDoSwitcher.torEnabled = !(addon.userDisabled);
                }else{
                    JonDoSwitcher.torEnabled = false;
                }
                JonDoSwitcher.torChecked = true;
                if(JonDoSwitcher.jondoChecked){
                    JonDoSwitcher.validateCurrentNetwork();
                }
            });
        }catch(e){
            //Services.prompt.alert(null, "JonDoBrowser", e);
        }
    },

    //validate current network preferences with enabled addons
    //switch addons if necessary
    validateCurrentNetwork : () => {
        //if this is the first launch after install, turn on jondo
        try{
            //initialize xpi paths
            JonDoSwitcher.getXpiPaths();
            if(prefsService){
                let prefsBranch = prefsService.getBranch("extensions.jondoswitcher.");
                if(prefsBranch){
                    if(prefsBranch.getIntPref("is_first_launch") == 1){
                        prefsBranch.setIntPref("is_first_launch", 0);
                        if(!JonDoSwitcher.jondoEnabled && !JonDoSwitcher.torEnabled){
                            JonDoSwitcher.shouldBackupDirectProxyPrefs = false;
                            JonDoSwitcher.switchAddons(true, false);
                            JonDoSwitcher.restart();
                            return;
                        }
                    }
                }
            }
        }catch(e){
            //Services.prompt.alert(null, "JonDoBrowser", e);
        }

        //create extensionsDir.txt file that contains extensions directory path
        try{
            var mOS = xreService.OS; 
            var txtFile = null;
            //for osx, print to JonDoBrowser-Data/extensionsDir.txt
            if(mOS == "Darwin"){
                txtFile = JonDoSwitcher.extTxtDir.clone();
                txtFile = txtFile.parent;
                txtFile = txtFile.parent;
                txtFile = txtFile.parent;
            }
            //for win/linux, print to JonDo/extensionsDir.txt
            else{
                txtFile = JonDoSwitcher.xpiSrcDir.clone();
            }
            txtFile.appendRelativePath("extensionsDir.txt");
            JonDoSwitcher.writeToExtensionDirFile(txtFile, JonDoSwitcher.xpiDestDir.path);
        }catch(e){
            //Services.prompt.alert(null, "JonDoBrowser", e);
        }   
        
        //if both are enabled, disable tor and restart
        if(JonDoSwitcher.jondoEnabled && JonDoSwitcher.torEnabled){
            Services.prompt.alert(null, "JonDoBrowser", "JonDo launch Error!\nPlease restart JonDoBrowser to fix this error.");
            JonDoSwitcher.switchAddons(true, false);
            JonDoSwitcher.restart();
            return;
        }

        //if only jondo is enabled
        if(JonDoSwitcher.jondoEnabled){
            JonDoSwitcher.curNetwork = 1;
            JonDoSwitcher.cloneProxySettings("extensions.jondoswitcher.jondobutton.", "network.proxy.");
            return;
        }

        //if only tor is enabled
        if (JonDoSwitcher.torEnabled) {
            JonDoSwitcher.curNetwork = 2;
            JonDoSwitcher.cloneProxySettings("extensions.jondoswitcher.torbutton.", "network.proxy.");
            return;
        }
        //if both are disabled
        if(!JonDoSwitcher.jondoEnabled && !JonDoSwitcher.torEnabled){
            JonDoSwitcher.cloneProxySettings("extensions.jondoswitcher.direct.", "network.proxy.");
            JonDoSwitcher.curNetwork = 0;
            //if tor is temporarily turned off during update donwload
            //turn it back on
            try{
                if(prefsService){
                    let prefsBranch = prefsService.getBranch("extensions.jondoswitcher.");
                    if (prefsBranch) {
                        let currentNetwork = prefsBranch.getCharPref("current_network");
                        let updateStatus = prefsBranch.getIntPref("update_status");
                        if(currentNetwork == "tor" && updateStatus == 1){
                            JonDoSwitcher.setUpdateStatus(0);
                            JonDoSwitcher.switchAddons(false, true);
                            JonDoSwitcher.curNetwork = 2;
                            JonDoSwitcher.continueUpdates();
                        }
                    }
                }
            }catch(e){
                //Services.prompt.alert(null, "JonDoBrowser", e);
            }
        }
    },

    getProxy : () => {
        if(JonDoSwitcher.curNetwork == -1){
            return "Unknown";
        }else if(JonDoSwitcher.curNetwork == 0){
            return "Direct";
        }else if(JonDoSwitcher.curNetwork == 1){
            return "JonDo";
        }else if(JonDoSwitcher.curNetwork == 2){
            return "Tor";
        }
    },

    //continue to update on browser
    //called when browser switches from direct connection to tor network for update
    continueUpdates : () => {
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
    },

    //flag1 : enable jondo
    //flag2 : enable tor
    switchAddons : (flag1, flag2) => {
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
        if(JonDoSwitcher.xpiSrcDir != null && JonDoSwitcher.xpiSrcDir.exists() && 
           JonDoSwitcher.xpiDestDir != null && JonDoSwitcher.xpiDestDir.exists()){
            // if jondo is enabled, jondobutton & jondolauncher are copied to extension directory
            if(flag1){
                let fileJonDoButton = JonDoSwitcher.xpiSrcDir.clone(); 
                fileJonDoButton.appendRelativePath("info@jondos.de.xpi");

                let fileJonDoLauncher = JonDoSwitcher.xpiSrcDir.clone(); 
                fileJonDoLauncher.appendRelativePath("jondo-launcher@jondos.de.xpi");
                try{
                    if(fileJonDoButton.exists()){
                        fileJonDoButton.copyTo(JonDoSwitcher.xpiDestDir, "");
                    }
                    if(fileJonDoLauncher.exists()){
                        fileJonDoLauncher.copyTo(JonDoSwitcher.xpiDestDir, "");
                    }
                }catch(e){

                }
            } 
            // if tor is enabled, torbutton & torlauncher are copied to extension directory
            else if(flag2){
                let fileTorButton = JonDoSwitcher.xpiSrcDir.clone(); 
                fileTorButton.appendRelativePath("torbutton@torproject.org.xpi");

                let fileTorLauncher = JonDoSwitcher.xpiSrcDir.clone(); 
                fileTorLauncher.appendRelativePath("tor-launcher@torproject.org.xpi");

                try{
                    if(fileTorButton.exists()){
                        fileTorButton.copyTo(JonDoSwitcher.xpiDestDir, "");
                    }
                    if(fileTorLauncher.exists()){
                        fileTorLauncher.copyTo(JonDoSwitcher.xpiDestDir, "");
                    }
                }catch(e){

                }
            }
            // if connection is direct, jondobutton is copied
            else {
                let fileJonDoButton = JonDoSwitcher.xpiSrcDir.clone(); 
                fileJonDoButton.appendRelativePath("info@jondos.de.xpi");
                try{
                    if(fileJonDoButton.exists()){
                        fileJonDoButton.copyTo(JonDoSwitcher.xpiDestDir, "");
                    }
                }catch(e){

                }
            } 
        }

        // set preferences so that socks proxy is not enforced except for tor,
        // in which case, socks proxy will be turned on by torbutton after restart
        /*
        try{
            if (prefsService)
            {
                let prefsBranch = prefsService.getBranch("network.proxy.");
                if (prefsBranch)
                {
                    prefsBranch.setCharPref("socks", "");
                    prefsBranch.setIntPref("socks_port", 0);
                    prefsBranch.setBoolPref("socks_remote_dns", false);
                }    
            }
        } catch (e) {}
        */
        
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
    },

    // enable jondo addons and restart
    enableJonDo : () => {
        if(JonDoSwitcher.curNetwork == 1) return;
        // prepare for sending messages
        var window = windowMediator.getMostRecentWindow("navigator:browser");
        if(window.confirm(JonDoSwitcher.stringsBundle.GetStringFromName("browserRestartAlert1") + "\n" + JonDoSwitcher.stringsBundle.GetStringFromName("browserRestartAlert2")) == false) return;
        //backup whatever proxy settings the browser currently has and restore.
        if(JonDoSwitcher.curNetwork == 0){
            JonDoSwitcher.cloneProxySettings("network.proxy.", "extensions.jondoswitcher.direct.");
        }
        JonDoSwitcher.cloneProxySettings("extensions.jondoswitcher.jondobutton.", "network.proxy.");
        JonDoSwitcher.setCurrentNetwork("jondo");
        JonDoSwitcher.switchAddons(true, false);
        JonDoSwitcher.curNetwork = 1;
        JonDoSwitcher.changeHomePage("about:tor");
        JonDoSwitcher.restart();
    },

    enableTor : () => {
        if(JonDoSwitcher.curNetwork == 2) return;
        // prepare for sending messages
        var window = windowMediator.getMostRecentWindow("navigator:browser");
        if(window.confirm(JonDoSwitcher.stringsBundle.GetStringFromName("browserRestartAlert1") + "\n" + JonDoSwitcher.stringsBundle.GetStringFromName("browserRestartAlert2")) == false) return;
        //backup whatever proxy settings the browser currently has and restore.
        if(JonDoSwitcher.curNetwork == 0){
            JonDoSwitcher.cloneProxySettings("network.proxy.", "extensions.jondoswitcher.direct.");
        }
        JonDoSwitcher.cloneProxySettings("extensions.jondoswitcher.torbutton.", "network.proxy.");
        JonDoSwitcher.setCurrentNetwork("tor");
        JonDoSwitcher.switchAddons(false, true);
        JonDoSwitcher.curNetwork = 2;
        JonDoSwitcher.changeHomePage("about:tor");
        JonDoSwitcher.restart();
    },

    disableAllProxies : () => {
        if(JonDoSwitcher.curNetwork == 0) return;
        // prepare for sending messages
        var window = windowMediator.getMostRecentWindow("navigator:browser");
        if(window.confirm(JonDoSwitcher.stringsBundle.GetStringFromName("browserRestartAlert1") + "\n" + JonDoSwitcher.stringsBundle.GetStringFromName("browserRestartAlert2")) == false) return;
        //restore proxy settings set by user
        JonDoSwitcher.cloneProxySettings("extensions.jondoswitcher.direct.", "network.proxy.");
        JonDoSwitcher.setCurrentNetwork("direct");
        JonDoSwitcher.switchAddons(false, false);
        JonDoSwitcher.curNetwork = 2;
        JonDoSwitcher.changeHomePage("about:noproxy");
        JonDoSwitcher.restart();
    },

    setCurrentNetwork : (networkString) => {
        try{
            if (prefsService)
            {
                let prefsBranch = prefsService.getBranch("extensions.jondoswitcher.");
                if (prefsBranch) {
                    prefsBranch.setCharPref("current_network", networkString);
                }
            }
        }catch(e){
            //Services.prompt.alert(null, "JonDoBrowser", e);
        }
    },

    setUpdateStatus : (updateStatus) => {
        try{
            if (prefsService)
            {
                let prefsBranch = prefsService.getBranch("extensions.jondoswitcher.");
                if (prefsBranch) {
                    prefsBranch.setIntPref("update_status", updateStatus);
                }
            }
        }catch(e){
            //Services.prompt.alert(null, "JonDoBrowser", e);
        }
    },

    restart : () => {
        try{
          JonDoCommunicator.socketControl.silentMode = true;
          let canceled = Cc["@mozilla.org/supports-PRBool;1"].createInstance(Ci.nsISupportsPRBool);
          Services.obs.notifyObservers(canceled, "quit-application-requested", "restart");
          if (canceled.data) return false; // somebody canceled our quit request
          // restart
          Cc['@mozilla.org/toolkit/app-startup;1'].getService(Ci.nsIAppStartup).quit(Ci.nsIAppStartup.eAttemptQuit | Ci.nsIAppStartup.eRestart);

          return true;
        }catch (e){}
    },


    cloneProxySettings : (srcBranchName, destBranchName) => {
        try{
            if(prefsService){
                var srcBranch = prefsService.getBranch(srcBranchName);
                var destBranch = prefsService.getBranch(destBranchName);
                destBranch.setIntPref("autoconfig_retry_interval_max", srcBranch.getIntPref("autoconfig_retry_interval_max"));
                destBranch.setIntPref("autoconfig_retry_interval_min", srcBranch.getIntPref("autoconfig_retry_interval_min"));
                destBranch.setCharPref("autoconfig_url", srcBranch.getCharPref("autoconfig_url"));

                destBranch.setIntPref("failover_timeout", srcBranch.getIntPref("failover_timeout"));

                destBranch.setCharPref("ftp", srcBranch.getCharPref("ftp"));
                destBranch.setIntPref("ftp_port", srcBranch.getIntPref("ftp_port"));
                destBranch.setCharPref("http", srcBranch.getCharPref("http"));
                destBranch.setIntPref("http_port", srcBranch.getIntPref("http_port"));

                destBranch.setCharPref("no_proxies_on", srcBranch.getCharPref("no_proxies_on"));
                destBranch.setBoolPref("proxy_over_tls", srcBranch.getBoolPref("proxy_over_tls"));
                destBranch.setBoolPref("share_proxy_settings", srcBranch.getBoolPref("share_proxy_settings"));

                destBranch.setCharPref("socks", srcBranch.getCharPref("socks"));
                destBranch.setIntPref("socks_port", srcBranch.getIntPref("socks_port"));
                destBranch.setBoolPref("socks_remote_dns", srcBranch.getBoolPref("socks_remote_dns"));
                destBranch.setIntPref("socks_version", srcBranch.getIntPref("socks_version"));

                destBranch.setCharPref("ssl", srcBranch.getCharPref("ssl"));
                destBranch.setIntPref("ssl_port", srcBranch.getIntPref("ssl_port"));
                
                destBranch.setIntPref("type", srcBranch.getIntPref("type"));

                srcBranch = prefsService.getBranch(srcBranchName + "autoconfig_url.");
                destBranch = prefsService.getBranch(destBranchName + "autoconfig_url.");
                destBranch.setBoolPref("include_path", srcBranch.getBoolPref("include_path"));
            }
        } catch(e){
            //Services.prompt.alert(null, "JonDoBrowser", e);
        }
    },

    changeHomePage : (homePage) => {
        try{
            if(prefsService){
                var branch = prefsService.getBranch("browser.startup.");
                branch.setCharPref("homepage", homePage);
            }
        } catch(e){
            //Services.prompt.alert(null, "JonDoBrowser", e);
        }
    },

    writeToExtensionDirFile : (file, data) => {
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
    },

    getXpiPaths : () => {
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
        JonDoSwitcher.xpiSrcDir = topDir.clone();
        // extensions directory where xpi's should be copied
        JonDoSwitcher.xpiDestDir = toolkitProfileService.getProfileByName("default").rootDir.clone();
        if(mOS == "WINNT"){
            JonDoSwitcher.xpiSrcDir.appendRelativePath("JonDo");
            JonDoSwitcher.xpiDestDir.appendRelativePath("extensions");
        }else if(mOS == "Darwin"){
            JonDoSwitcher.xpiSrcDir.appendRelativePath("Contents/MacOS/JonDo");
            JonDoSwitcher.xpiDestDir.appendRelativePath("extensions");
            JonDoSwitcher.extTxtDir = JonDoSwitcher.xpiDestDir.clone();
            // special case : /extensions/extensions directory
            let tmpXpiDestDir = JonDoSwitcher.xpiDestDir.clone();
            tmpXpiDestDir.appendRelativePath("extensions");
            if(tmpXpiDestDir.exists()){
                JonDoSwitcher.xpiDestDir = tmpXpiDestDir;
            }
        }else{
            JonDoSwitcher.xpiSrcDir.appendRelativePath("JonDo");
            JonDoSwitcher.xpiDestDir.appendRelativePath("extensions");
        }
    },
}

var JonDoNetworkIntercepter = {
   observerService : null,
   securityLevel : 4,

    init : function() {
        JonDoNetworkIntercepter.observerService = Cc["@mozilla.org/observer-service;1"].getService(Ci.nsIObserverService);
        JonDoNetworkIntercepter.observerService.addObserver(JonDoNetworkIntercepter.observerRequestHandler, 'http-on-modify-request', false);
        JonDoNetworkIntercepter.observerService.addObserver(JonDoNetworkIntercepter.observerResponseHandler, 'http-on-examine-response', false);
        JonDoNetworkIntercepter.observerService.addObserver(JonDoNetworkIntercepter.observerResponseHandler, 'http-on-examine-cached-response', false);
    },

    uninit : function() {
        JonDoNetworkIntercepter.observerService.removeObserver(JonDoNetworkIntercepter.observerRequestHandler, 'http-on-modify-request', false);
        JonDoNetworkIntercepter.observerService.removeObserver(JonDoNetworkIntercepter.observerResponseHandler, 'http-on-examine-response', false);
        JonDoNetworkIntercepter.observerService.removeObserver(JonDoNetworkIntercepter.observerResponseHandler, 'http-on-examine-cached-response', false);
    },

    setSecurityLevel : function() {
        try{
            if (prefsService)
            {
                let prefsBranch = prefsService.getBranch("extensions.torbutton.");
                if (prefsBranch) {
                    JonDoNetworkIntercepter.securityLevel = prefsBranch.getIntPref("security_slider");
                }
            }
        }catch(e){}
    },

    observerRequestHandler : { observe : function(subject, topic, data) {
        // http interface
        var httpChannel = subject.QueryInterface(Ci.nsIHttpChannel);
        if(httpChannel === null) {
            return;
        }
        
        // request packet filtering in jondo mode
        if(JonDoSwitcher.jondoEnabled){
            // only for maximum security case
            if(JonDoNetworkIntercepter.securityLevel == 1){
                try{
                    httpChannel.setRequestHeader("Proxy-Connection", "close", false);
                    httpChannel.setRequestHeader("Connection", "close", false);
                }catch(e){
                    //Services.prompt.alert(null, "JonDoBrowser", e);
                }
            }
        }
    }},

    observerResponseHandler : { observe : function(subject, topic, data) {
        // http interface
        var httpChannel = subject.QueryInterface(Ci.nsIHttpChannel);
        if(httpChannel === null) {
            return;
        }
        
        // update response packet filtering in tor mode
        if(JonDoSwitcher.torEnabled){
            //only for jondo update server
            var url = httpChannel.URI.spec;
            if(url.includes("jondobrowser.jondos.de/alpha/") || 
                url.includes("jondobrowser.jondos.de/beta/") || 
                url.includes("jondobrowser.jondos.de/product/")){
                try{
                    var contentLength = httpChannel.getResponseHeader('Content-Length');
                    if (contentLength){
                        contentLength = parseInt(contentLength);
                        //if update available
                        if(contentLength > 100){
                            if(!JonDoSwitcher.dontAskTorToggling && !JonDoSwitcher.updateDialogShown){
                                JonDoSwitcher.updateDialogShown = true;
                                var params = {inn:null, out:""};
                                var window = windowMediator.getMostRecentWindow("navigator:browser");
                                window.openDialog("chrome://jondoswitcher/content/jondo-update-dialog.xul", "",
                                    "chrome, dialog, modal, resizable=no, centerscreen", params).focus();
                                if(params.out == "ok"){
                                    JonDoSwitcher.setCurrentNetwork("tor");
                                    JonDoSwitcher.setUpdateStatus(1);
                                    JonDoSwitcher.switchAddons(false, false);
                                    JonDoSwitcher.restart();
                                }else if(params.out == "cancel"){
                                    JonDoSwitcher.dontAskTorToggling = true;
                                }
                            }
                        }
                    }
                }catch(e){
                    //Services.prompt.alert(null, "JonDoBrowser", e);
                }
            }
        }
    }}
};

var BrowserShutdownIntercepter = {
   observerService : null,

   init : function() {
      BrowserShutdownIntercepter.observerService = Cc["@mozilla.org/observer-service;1"].getService(Ci.nsIObserverService);
      BrowserShutdownIntercepter.observerService.addObserver(BrowserShutdownIntercepter.observerShutdownHandler, 'quit-application-requested', false);
   },

   uninit : function() {
      BrowserShutdownIntercepter.observerService.removeObserver(BrowserShutdownIntercepter.observerShutdownHandler, 'quit-application-requested', false);
   },

   // clone proxy settings in direct connection mode
   observerShutdownHandler : { observe : function(subject, topic, data) {
      JonDoCommunicator.socketControl.silentMode = true;
      if(JonDoSwitcher.curNetwork == 0 && JonDoSwitcher.shouldBackupDirectProxyPrefs){
          JonDoSwitcher.cloneProxySettings("network.proxy.", "extensions.jondoswitcher.direct.");
      }
   }}
};

/* Protocol:
     Workflow:
         At first, browser tries to connect to server port 40012 once every second for up to 10 times.
         If this fails, Jondo is not started and hence should do sth else.
         In addition, heartbeat happens every second after connection was established.
         When sending socket packet, always send secureKey along with it.
         Otherwise, the connection will be closed by server.

      Handshake: Client sends "get-token", server sends "token" with a long randomized alphabetical key.
      Heartbeat: Client sends "ping" every second, Server should reply with "pong" asap.
                 If server does not reply within 3 seconds, client thinks the connection is dead.
      Request: Client can send "switch-cascade" to change to "New Identity".
      Push: Server can push "open-new-tab" to tell the client to open a new tab with given url.
 */

var JonDoCommunicator = {
  socketControl : 
      {
        jondoMode: true,
        silentMode: false,
      },
  startConnectionTimerObject : null,
  startConnectionFailedCount : 0,
  startConnectionMaxFailCount : 10,
  connectionTimeout : 5,

  socketConnection : null,
  readBuffer : null,
  secureKey : null,
    
  pingTimerObject : null,
  lastPongTime : null,

  // "new identity" button clicked
  sendSwitchCascadeCommand : (event)=>{
      if(JonDoCommunicator.socketConnection && JonDoCommunicator.secureKey)
        JonDoCommunicator.sendData(JonDoCommunicator.socketConnection, "switch-cascade", JonDoCommunicator.secureKey);
  },

  // heartbeat
  sendPing : ()=>{
    if(JonDoCommunicator.socketConnection && JonDoCommunicator.secureKey){
      if(JonDoCommunicator.lastPongTime){
        var currentTime = new Date().getMilliseconds();
        if((currentTime - JonDoCommunicator.lastPongTime) > 3 * 1000){
          JonDoCommunicator.shutDownSocketConnection();
          return;
        }
      }  
      JonDoCommunicator.sendData(JonDoCommunicator.socketConnection, "ping", JonDoCommunicator.secureKey);
    }
  },

  // show jondo connection error alert
  showConnectionError : ()=>{
      if(!JonDoCommunicator.socketControl.silentMode)
          Services.prompt.alert(null, "Connecting to Jondo", 
              "Cannot establish connection with Jondo.\r\nRestarting the browser might fix this issue.");
  },

  // create and open socket connection
  openConnection : ()=>{
      var conn;
      try
      {
        let sts = Cc["@mozilla.org/network/socket-transport-service;1"].getService(Ci.nsISocketTransportService);

        // Create an instance of a socket transport.
        let socket = sts.createTransport(null, 0, "127.0.0.1", 40012, null);
        // open a socket which is non-blocking
        var flags = 0;
        var segSize = 0;
        var segCount = 0;
        var inStream = socket.openInputStream(flags, segSize, segCount);
        var outStream = socket.openOutputStream(flags, segSize, segCount);
        var binInStream  = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
        var binOutStream = Cc["@mozilla.org/binaryoutputstream;1"].createInstance(Ci.nsIBinaryOutputStream);
        binInStream.setInputStream(inStream);
        binOutStream.setOutputStream(outStream);
        conn = { socket: socket, inStream: inStream, binInStream: binInStream, binOutStream: binOutStream };
      }
      catch(e)
      {
        return null;
      }

      return conn;
  },
    
  // close connection
  closeConnection : (aConn)=>{
      if (aConn && aConn.socket)
      {
        if (aConn.binInStream)  aConn.binInStream.close();
        if (aConn.binOutStream) aConn.binOutStream.close();
        aConn.socket.close(Cr.NS_OK);
      }
  },

  // shut down connection silently
  shutDownSocketConnectionSilently : ()=>{
      if (JonDoCommunicator.socketConnection)
      {
        JonDoCommunicator.closeConnection(JonDoCommunicator.socketConnection);
        JonDoCommunicator.socketConnection = null;
        JonDoCommunicator.readBuffer = null;
        JonDoCommunicator.secureKey = null;
      }
  },

  // shut down connection and show alert
  shutDownSocketConnection : ()=>{
      JonDoCommunicator.shutDownSocketConnectionSilently();
      JonDoCommunicator.showConnectionError();
  },

  // stop connecting to socket
  clearConnectionTimer : ()=> {
      JonDoCommunicator.clearInterval(JonDoCommunicator.startConnectionTimerObject);
      JonDoCommunicator.startConnectionTimerObject = null;
  },

  // stop heartbeat
  clearPingTimer : ()=> {
      JonDoCommunicator.clearInterval(JonDoCommunicator.pingTimerObject);
      JonDoCommunicator.pingTimerObject = null;
  },

  // start socket connection and event handling
  startConnection : ()=>{
      if (JonDoCommunicator.socketConnection) {
          JonDoCommunicator.clearConnectionTimer();
          return;
      }
      if (JonDoCommunicator.startConnectionFailedCount >= JonDoCommunicator.startConnectionMaxFailCount){
          JonDoCommunicator.clearConnectionTimer();
          JonDoCommunicator.showConnectionError();
          return;
      }

      var conn = JonDoCommunicator.openConnection();
      if (!conn)
      {
        if(!JonDoCommunicator.socketControl.silentMode)
          Services.prompt.alert(null, "Connecting to Jondo",
            "Could not connect to Jondo control port.");
        return;
      }

      JonDoCommunicator.sendData(conn, "get-token", "");
      var reply = JonDoCommunicator.readLine(conn);
      if (reply && reply.startsWith("token"))
      {
        var ind = reply.indexOf(",");
        if(ind >= 0){
          JonDoCommunicator.secureKey = reply.substring(ind + 1);
          if(JonDoCommunicator.secureKey == "") JonDoCommunicator.secureKey = null;
        }
      }
      if (!JonDoCommunicator.secureKey)
      {
        JonDoCommunicator.closeConnection(conn);
        JonDoCommunicator.startConnectionFailedCount++;
        if(JonDoCommunicator.startConnectionFailedCount >= JonDoCommunicator.startConnectionMaxFailCount){
          JonDoCommunicator.clearConnectionTimer();
          JonDoCommunicator.showConnectionError();
        }
        return;
      }

      JonDoCommunicator.clearConnectionTimer();
      
      // save connection
      JonDoCommunicator.socketConnection = conn;
      JonDoCommunicator.waitForRead();
  },

  // send command through socket and receive 1 line in response
  sendData : (aConn, aCmd, aArgs)=> {
      if (aConn)
      {
        var cmd = aCmd;
        if (aArgs) cmd += ',' + aArgs;
        cmd += "\r\n";
        JonDoCommunicator.setTimeout(aConn);
        aConn.binOutStream.writeBytes(cmd, cmd.length);
        JonDoCommunicator.clearTimeout(aConn);
      }
  },

  // read one line from socket
  // must be used only right after connecting
  // (blocking)
  readLine : (aConn)=>{
      JonDoCommunicator.setTimeout(aConn);
      var aInput = aConn.binInStream;
      var str = "";
      while(true)
      {
        try
        {
          let bytes = aInput.readBytes(1);
          if ('\n' == bytes) break;
          str += bytes;
        }
        catch (e)
        {
          // if server is not loaded yet,
          // schedule another startConnection in 1 second
          if (e.result != Cr.NS_BASE_STREAM_WOULD_BLOCK) {
              return null;
          }
        }
      }
      var len = str.length;
      if ((len > 0) && ('\r' == str.substr(len - 1)))
        str = str.substr(0, len - 1);
      JonDoCommunicator.clearTimeout(aConn);
      return str;
  },

  // set and clear socket timeouts
  setTimeout : (aConn)=>{
      if (aConn && aConn.socket)
        aConn.socket.setTimeout(Ci.nsISocketTransport.TIMEOUT_READ_WRITE, JonDoCommunicator.connectionTimeout);
  },
  clearTimeout : (aConn)=>{
      if (aConn && aConn.socket)
      {
        var secs = Math.pow(2,32) - 1; // UINT32_MAX
        aConn.socket.setTimeout(Ci.nsISocketTransport.TIMEOUT_READ_WRITE, secs);
      }
  },

  // non-blocking read
  waitForRead : ()=>{
      if (!JonDoCommunicator.socketConnection) return;

      var eventReader = // An implementation of nsIInputStreamCallback.
      {
        onInputStreamReady: function(aInStream)
        {
          if (!JonDoCommunicator.socketConnection || (JonDoCommunicator.socketConnection.inStream != aInStream))
          {
            if(!JonDoCommunicator.socketControl.silentMode)
              Services.prompt.alert(null, "Connecting to Jondo",
                "Could not read from Jondo control port.");
            return;
          }

          try
          {
            var binStream = JonDoCommunicator.socketConnection.binInStream;
            var bytes = binStream.readBytes(binStream.available());
            if (!JonDoCommunicator.readBuffer)
              JonDoCommunicator.readBuffer = bytes;
            else
              JonDoCommunicator.readBuffer += bytes;
            var result = JonDoCommunicator.processReadBuffer();

            if(result){
              var ind = result.indexOf(",");
              if(ind >= 0){
                  var command = result.substring(0, ind);
                  var data = result.substring(ind + 1);
                  if(command && data){
                      if(command == "open-new-tab"){
                          var url = data;
                          // if file url contains "file:/" with just a single slash
                          // replace it with triple slash for consistency
                          if(!url.includes("file:///")){
                            if(url.includes("file://")){
                              url = url.replace("file://", "file:///");
                            }else if(url.includes("file:/")){
                              url = url.replace("file:/", "file:///");
                            }
                          }

                          // reusing open tabs for a new url opening
                          // if not, open a new tab with the given url and set focus                        
                          var browserEnumerator = windowMediator.getEnumerator("navigator:browser");

                          // Check each browser instance for our URL
                          var found = false;
                          while (!found && browserEnumerator.hasMoreElements()) {
                            var browserWin = browserEnumerator.getNext();
                            var tabbrowser = browserWin.gBrowser;

                            // Check each tab of this browser instance
                            var numTabs = tabbrowser.browsers.length;
                            for (var index = 0; index < numTabs; index++) {
                              var currentBrowser = tabbrowser.getBrowserAtIndex(index);
                              if (url == currentBrowser.currentURI.spec) {

                                // The URL is already opened. Select this tab.
                                tabbrowser.selectedTab = tabbrowser.tabContainer.childNodes[index];

                                // Focus *this* browser-window
                                browserWin.focus();

                                found = true;
                                break;
                              }
                            }
                          }

                          // Our URL isn't open. Open it now.
                          if (!found) {
                            var recentWindow = windowMediator.getMostRecentWindow("navigator:browser");
                            if (recentWindow) {
                              // Use an existing browser window
                              recentWindow.delayedOpenTab(url, null, null, null, null);
                            }
                            else {
                              // No browser windows are open, so open a new one.
                              window.open(url);
                            }
                          }
                      }
                  }
              }else{
                if(result == "pong"){
                  JonDoCommunicator.lastPongTime = new Date().getMilliseconds();
                }
              }
            }

            JonDoCommunicator.waitForRead();
          }
          catch (e)
          {
            JonDoCommunicator.shutDownSocketConnectionSilently();
          }
        }
      };

      var curThread = Cc["@mozilla.org/thread-manager;1"].getService()
                        .currentThread;
      var asyncInStream = JonDoCommunicator.socketConnection.inStream
                              .QueryInterface(Ci.nsIAsyncInputStream);
      asyncInStream.asyncWait(eventReader, 0, 0, curThread);
  },
   
  // process read buffer
  processReadBuffer : ()=>{
      var result = null;
      var replyData = JonDoCommunicator.readBuffer;
      if (!replyData) return null;

      var idx = -1;
      do
      {
        idx = replyData.indexOf('\n');
        if (idx >= 0)
        {
          let line = replyData.substring(0, idx);
          replyData = replyData.substring(idx + 1);
          let len = line.length;
          if ((len > 0) && ('\r' == line.substr(len - 1)))
            line = line.substr(0, len - 1);
          result = line;
        }
      } while ((idx >= 0) && replyData)

      JonDoCommunicator.readBuffer = replyData;
      return result;
  },

  // brand-new setInterval, clearInterval for javascript modules without using window object
  setInterval : (aFunction, aTime) => {
    var timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    timer.init({observe: (aSubject, aTopic, aData) => {aFunction();}}, aTime, Ci.nsITimer.TYPE_REPEATING_SLACK);
    return timer;
  },
  clearInterval : (aTimer) => {
    aTimer.cancel();
  },

  // execution entry point
  startSocketConnecting : () => {
    // already successful
    if(JonDoCommunicator.socketConnection) return;
    // already failed
    if(JonDoCommunicator.startConnectionFailedCount > JonDoCommunicator.startConnectionMaxFailCount) return;
    // if already trying
    if(JonDoCommunicator.startConnectionTimerObject) return;
    // start connection timer if it is not started yet
    if(!JonDoCommunicator.startConnectionTimerObject)
        JonDoCommunicator.startConnectionTimerObject = JonDoCommunicator.setInterval(JonDoCommunicator.startConnection, 1000);
    // start ping timer if it is not started yet
    if(!JonDoCommunicator.pingTimerObject)
        JonDoCommunicator.pingTimerObject = JonDoCommunicator.setInterval(JonDoCommunicator.sendPing, 1000);
  },
}

var EXPORTED_SYMBOLS = [
                          "JonDoSwitcher",
                          "JonDoCommunicator",
                          "JonDoNetworkIntercepter"
                       ];