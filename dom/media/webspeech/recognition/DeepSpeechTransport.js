/* This Source Code Form is subject to the terms of the Mozilla Public
* License, v. 2.0. If a copy of the MPL was not distributed with this file,
* You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { classes: Cc, interfaces: Ci, utils: Cu, results: Cr } = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");

// for testing
function log(aMsg) {
  dump("-*- DeepSpeechTransport.js : " + aMsg + "\n");
}

function DeepSpeechTransport() {
  this._reset();
}

DeepSpeechTransport.prototype = {
  classID: Components.ID("{b719e86d-e344-46ca-98bd-9ec9766e7e6d}"),
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIDeepSpeechTransport]),

  start: function(aWindow, aListener, aURI, aMediaStream, continuous) {
    if (
      !aWindow || !aListener || aURI === undefined || 
      !aMediaStream || continuous === undefined
    ) {
      throw Cr.NS_ERROR_ILLEGAL_VALUE;
    }

    if (this._window) { // already started
      throw Cr.NS_ERROR_UNEXPECTED;
    }

    this._window = aWindow;
    this._listener = aListener;
    this._uri = aURI;

    let onError = () => {
      aListener.onError(Cr.NS_ERROR_FAILURE);
      aListener.onClose();
    }

    try {
      if (aURI.startsWith("ws://") || aURI.startsWith("wss://")) {
        this._transportType = "ws";
        this._wsInitTransport(aMediaStream, continuous);
      } else { // TODO? use PeerConnection for long speech
        onError();
      }
    } catch (e) {
      onError();
    }
  },

  stop: function() {
    if (!this._window) {
      return;
    }

    if (this._transportType === "ws") {
      this._wsStop();
    }
  },

  abort: function() {
    if (!this._window) {
      return;
    }

    this._isAborted = true;
    this.stop();
  },

  _reset: function() {
    this._window = null;
    this._listener = null;
    this._uri = null;
    this._isAborted = false;
    this._transportType = null;
  },

  /******************** WebSocket Transport *******************/

  _wsInitTransport: function(aMediaStream, continuous = false) {
    this._wsReset();

    let ws = new this._window.WebSocket(this._uri);
    this._ws = ws;

    ws.onopen = aEvent => {
      if (continuous) {
        this._wsRecorder.start(1000); // TODO? find good timeslice
      } else {
        this._wsRecorder.start();
      }
      this._wsState = "sending";
      this._listener.onOpen();
    };

    ws.onmessage = aEvent => {
      try {
        let aResult = JSON.parse(aEvent.data);

        if (
          typeof aResult.transcript !== "string" || 
          typeof aResult.confidence !== "number" || 
          typeof aResult.final !== "boolean"
        ) {
          throw true; // just stop
        }

        this._listener.onResult(
          aResult.transcript, 
          aResult.confidence, 
          aResult.final && !this._wsIsDataError // not final if recording failed
        );

        if (aResult.final) {
          this._wsCloseTransport();
        }
      } catch (e) {
        this._wsCloseTransport(true);
      }
    };

    ws.onclose = aEvent => {
      // server shouldn't close the connection
      this._wsCloseTransport(true);
    };

    /************************************/

    let recorder = new this._window.MediaRecorder(
      aMediaStream,
      { mimeType : "audio/ogg", audioBitsPerSecond: 8000 } // 8 kb/s
    );
    this._wsRecorder = recorder;

    recorder.ondataavailable = aEvent => {
      this._ws.send(aEvent.data);
    };

    recorder.onstop = aEvent => {
      this._ws.send("done");
      this._wsState = "waiting";
      this._wsCleanUpRecorder();
    };

    recorder.onerror = aEvent => {
      // do not stop yet
      // keep working with available speech
      this._wsIsDataError = true;
    };
  },

  _wsStop: function() {
    switch (this._wsState) {
    case "idle":
      this._wsCloseTransport();
      break;
    case "sending":
      if (this._isAborted) {
        this._wsCloseTransport();
      } else {
        this._wsStopRecording();
      }
      break;
    case "waiting":
      if (this._isAborted) {
        this._wsCloseTransport();
      }
      break;
    }
  },

  _wsReset: function() {
    this._ws = null;
    this._wsRecorder = null;
    this._wsIsDataError = false;
    this._wsState = "idle";
  },

  _wsStopRecording: function() {
    // must call only once
    if (this._wsRecorder && this._wsRecorder.state !== "inactive") {
      this._wsRecorder.stop();
    }
  },

  _wsCloseTransport: function(connError = false) {
    this._wsCleanUpRecorder();

    // ws
    if (this._ws) {
      this._ws.onopen = null;
      this._ws.onmessage = null;
      this._ws.onclose = null;
      this._ws.close();
    }

    // listener
    if (this._listener) {
      if (connError || this._wsIsDataError) {
        this._listener.onError(Cr.NS_ERROR_FAILURE);
      }
      this._listener.onClose();
    }

    // reset
    this._wsReset();
    this._reset();
  },

  _wsCleanUpRecorder: function() {
    if (this._wsRecorder) {
      this._wsRecorder.ondataavailable = null;
      this._wsRecorder.onerror = null;
      this._wsRecorder.onstop = null;
      this._wsStopRecording();
      this._wsRecorder = null;
    }
  }
};

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([DeepSpeechTransport]);
