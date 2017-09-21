const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;
Cu.import('resource://gre/modules/Services.jsm');

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

var socketControl = 
{
  jondoMode: true,
  silentMode: false,
};
var startConnectionTimerObject = null;
var startConnectionFailedCount = 0;
var startConnectionMaxFailCount = 10;
var connectionTimeout = 5;

var socketConnection = null;
var readBuffer = null;
var secureKey = null;
  
var pingTimerObject = null;
var lastPongTime = null;

// "new identity" button clicked
var sendSwitchCascadeCommand = (event)=>{
    if(socketConnection && secureKey)
      sendData(socketConnection, "switch-cascade", secureKey);
};

// heartbeat
var sendPing = ()=>{
  if(socketConnection && secureKey){
    if(lastPongTime){
      var currentTime = new Date().getMilliseconds();
      if((currentTime - lastPongTime) > 3 * 1000){
        shutDownSocketConnection();
        return;
      }
    }  
    sendData(socketConnection, "ping", secureKey);
  }
};

// show jondo connection error alert
var showConnectionError = ()=>{
    if(!socketControl.silentMode)
        Services.prompt.alert(null, "Connecting to Jondo", 
            "Cannot establish connection with Jondo.\r\nRestarting the browser might fix this issue.");
};

// create and open socket connection
var openConnection = ()=>{
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
};
  
// close connection
var closeConnection = (aConn)=>{
    if (aConn && aConn.socket)
    {
      if (aConn.binInStream)  aConn.binInStream.close();
      if (aConn.binOutStream) aConn.binOutStream.close();
      aConn.socket.close(Cr.NS_OK);
    }
};

// shut down connection silently
var shutDownSocketConnectionSilently = ()=>{
    if (socketConnection)
    {
      closeConnection(socketConnection);
      socketConnection = null;
      readBuffer = null;
      secureKey = null;
    }
};

// shut down connection and show alert
var shutDownSocketConnection = ()=>{
    shutDownSocketConnectionSilently();
    showConnectionError();
};

// stop connecting to socket
var clearConnectionTimer = ()=> {
    clearInterval(startConnectionTimerObject);
    startConnectionTimerObject = null;
};

// stop heartbeat
var clearPingTimer = ()=> {
    clearInterval(pingTimerObject);
    pingTimerObject = null;
};

// start socket connection and event handling
var startConnection = ()=>{
    if (socketConnection) {
        clearConnectionTimer();
        return;
    }
    if (startConnectionFailedCount >= startConnectionMaxFailCount){
        clearConnectionTimer();
        showConnectionError();
        return;
    }

    var conn = openConnection();
    if (!conn)
    {
      if(!socketControl.silentMode)
        Services.prompt.alert(null, "Connecting to Jondo",
          "Could not connect to Jondo control port.");
      return;
    }

    sendData(conn, "get-token", "");
    var reply = readLine(conn);
    if (reply && reply.startsWith("token"))
    {
      var ind = reply.indexOf(",");
      if(ind >= 0){
        secureKey = reply.substring(ind + 1);
        if(secureKey == "") secureKey = null;
      }
    }
    if (!secureKey)
    {
      closeConnection(conn);
      startConnectionFailedCount++;
      if(startConnectionFailedCount >= startConnectionMaxFailCount){
        clearConnectionTimer();
        showConnectionError();
      }
      return;
    }

    clearConnectionTimer();
    
    // save connection
    socketConnection = conn;
    waitForRead();
};

// send command through socket and receive 1 line in response
var sendData = (aConn, aCmd, aArgs)=> {
    if (aConn)
    {
      var cmd = aCmd;
      if (aArgs) cmd += ',' + aArgs;
      cmd += "\r\n";
      setTimeout(aConn);
      aConn.binOutStream.writeBytes(cmd, cmd.length);
      clearTimeout(aConn);
    }
};

// read one line from socket
// must be used only right after connecting
// (blocking)
var readLine = (aConn)=>{
    setTimeout(aConn);
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
    clearTimeout(aConn);
    return str;
};

// set and clear socket timeouts
var setTimeout = (aConn)=>{
    if (aConn && aConn.socket)
      aConn.socket.setTimeout(Ci.nsISocketTransport.TIMEOUT_READ_WRITE, connectionTimeout);
};
var clearTimeout = (aConn)=>{
    if (aConn && aConn.socket)
    {
      var secs = Math.pow(2,32) - 1; // UINT32_MAX
      aConn.socket.setTimeout(Ci.nsISocketTransport.TIMEOUT_READ_WRITE, secs);
    }
};

// non-blocking read
var waitForRead = ()=>{
    if (!socketConnection) return;

    var _this = this;
    var eventReader = // An implementation of nsIInputStreamCallback.
    {
      onInputStreamReady: function(aInStream)
      {
        if (!_this.socketConnection || (_this.socketConnection.inStream != aInStream))
        {
          if(!socketControl.silentMode)
            Services.prompt.alert(null, "Connecting to Jondo",
              "Could not read from Jondo control port.");
          return;
        }

        try
        {
          var binStream = _this.socketConnection.binInStream;
          var bytes = binStream.readBytes(binStream.available());
          if (!_this.readBuffer)
            _this.readBuffer = bytes;
          else
            _this.readBuffer += bytes;
          var result = _this.processReadBuffer();
          if(result){
            var ind = result.indexOf(",");
            if(ind >= 0){
                var command = result.substring(0, ind);
                var data = result.substring(ind + 1);
                if(command && data){
                    if(command == "open-new-tab"){
                        // reusing open tabs for a new url opening
                        // if not, open a new tab with the given url and set focus
                        var url = data;
                        var wm = Components.classes["@mozilla.org/appshell/window-mediator;1"].getService(Components.interfaces.nsIWindowMediator);
                        var browserEnumerator = wm.getEnumerator("navigator:browser");

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
                          var recentWindow = wm.getMostRecentWindow("navigator:browser");
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
                lastPongTime = new Date().getMilliseconds();
              }
            }
          }

          _this.waitForRead();
        }
        catch (e)
        {
          _this.shutDownSocketConnectionSilently();
        }
      }
    };

    var curThread = Cc["@mozilla.org/thread-manager;1"].getService()
                      .currentThread;
    var asyncInStream = socketConnection.inStream
                            .QueryInterface(Ci.nsIAsyncInputStream);
    asyncInStream.asyncWait(eventReader, 0, 0, curThread);
};
 
// process read buffer
var processReadBuffer = ()=>{
    var result = null;
    var replyData = readBuffer;
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

    readBuffer = replyData;
    return result;
};

// brand-new setInterval, clearInterval for javascript modules without using window object
function setInterval(aFunction, aTime)
{
  var timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
  timer.init({observe: (aSubject, aTopic, aData) => {aFunction();}}, aTime, Ci.nsITimer.TYPE_REPEATING_SLACK);
  return timer;
}
function clearInterval(aTimer)
{
  aTimer.cancel();
}

// execution entry point
function startSocketConnecting(){
  // already successful
  if(socketConnection) return;
  // already failed
  if(startConnectionFailedCount > startConnectionMaxFailCount) return;
  // if already trying
  if(startConnectionTimerObject) return;
  // start connection timer if it is not started yet
  if(!startConnectionTimerObject)
      startConnectionTimerObject = setInterval(startConnection, 1000);
  // start ping timer if it is not started yet
  if(!pingTimerObject)
      pingTimerObject = setInterval(sendPing, 1000);
}

var EXPORTED_SYMBOLS = [
                          "startSocketConnecting", 
                          "sendSwitchCascadeCommand", 
                          "socketControl"
                       ];