"use strict";

const USER = require("/boot/robot.json");
const SYS = require("./sys.json");

const FRAME = require("./trame.js");

const OS = require("os");
const FS = require("fs");
const IO = require("socket.io-client");
const EXEC = require("child_process").exec;
const RL = require("readline");
const NET = require("net");
const SPLIT = require("stream-split");
const SP = require("serialport");
const GPIO = require("pigpio").Gpio;
const I2C = require("i2c-bus");
const PCA9685 = require("pca9685");
const GPS = require("gps");
const noble = require('@abandonware/noble');

const FRAME0 = "$".charCodeAt();
const FRAME1S = "S".charCodeAt();
const FRAME1T = "T".charCodeAt();

const VERSION = Math.trunc(FS.statSync(__filename).mtimeMs);
const PROCESSTIME = Date.now();
const OSTIME = PROCESSTIME - OS.uptime() * 1000;

let sockets = {};
let currentServer = "";

let up = false;
let engine = false;
let upTimeout;

let initDone = false;
let initVideo = false;
let initUart = false;
let initPca = 0;
let initPcaLock = 0;

let conf = {};
let hard = {};
let tx;
let rx;
let confVideo;
let oldConfVideo;
let cmdDiffusion;
let cmdDiffAudio;
let contrastBoost = false;
let oldContrastBoost = false;
let autopilot;

let lastTimestamp = Date.now();
let lastFrame = Date.now();
let latencyAlarm = false;

let floatTargets16 = [];
let floatTargets8 = [];
let floatTargets1 = [];
let floatCommands16 = [];
let floatCommands8 = [];
let floatCommands1 = [];
let margins16 = [];
let margins8 = [];

let oldOutputs = [];
let backslashs = [];

let serial;
let serialGps;
let gps;

let i2c;
let gaugeType;

let pca9685Driver = [];
let gpioOutputs = [];

let prevCpus = OS.cpus();
let nbCpus = prevCpus.length;

let voltage = 0;
let battery = 0;
let cpuLoad = 0;
let socTemp = 0;
let link = 0;
let rssi = 0;
let bleRssi = 0;

if(typeof USER.SERVERS === "undefined")
 USER.SERVERS = SYS.SERVERS;

if(typeof USER.CMDDIFFUSION === "undefined")
 USER.CMDDIFFUSION = SYS.CMDDIFFUSION;

if(typeof USER.CMDDIFFAUDIO === "undefined")
 USER.CMDDIFFAUDIO = SYS.CMDDIFFAUDIO;

if(typeof USER.CMDTTS === "undefined")
 USER.CMDTTS = SYS.CMDTTS;

USER.SERVERS.forEach(function(server) {
 sockets[server] = IO.connect(server, {"connect timeout": 1000, transports: ["websocket"], path: "/" + SYS.SECUREMOTEPORT + "/socket.io"});
});

hard.DEBUG = true;
hard.TELEDEBUG = false;

trace("Client start", true);

i2c = I2C.openSync(1);

try {
 const CW2015WAKEUP = new Buffer.from([0x0a, 0x00]);
 i2c.i2cWriteSync(SYS.CW2015ADDRESS, 2, CW2015WAKEUP);
 gaugeType = "CW2015";
} catch(err) {
 try {
  i2c.readWordSync(SYS.MAX17043ADDRESS, 0x02);
  gaugeType = "MAX17043";
 } catch(err) {
  try {
   i2c.readWordSync(SYS.BQ27441ADDRESS, 0x04);
   gaugeType = "BQ27441";
  } catch(err) {
   i2c.closeSync();
   gaugeType = "";
  }
 }
}

setTimeout(function() {
 if(gaugeType)
  trace(gaugeType + " I2C fuel gauge detected", true);
 else
  trace("No I2C fuel gauge detected", true);
}, 1000);

function setInit() {
 initDone = initUart && initVideo && initPca == hard.PCA9685ADDRESSES.length;
}

function map(n, inMin, inMax, outMin, outMax) {
 return Math.trunc((n - inMin) * (outMax - outMin) / (inMax - inMin) + outMin);
}

function hmsm(date) {
 return ("0" + date.getHours()).slice(-2) + ":" +
        ("0" + date.getMinutes()).slice(-2) + ":" +
        ("0" + date.getSeconds()).slice(-2) + ":" +
        ("00" + date.getMilliseconds()).slice(-3);
}

function trace(message, mandatory) {
 if(mandatory || hard.DEBUG) {
  let trace = hmsm(new Date()) + " | " + message;
  FS.appendFile(SYS.LOGFILE, trace + "\n", function(err) {
  });
 }

 if(mandatory || hard.TELEDEBUG) {
  USER.SERVERS.forEach(function(server) {
   sockets[server].emit("serveurrobottrace", message);
  });
 }
}

function traces(id, messages, mandatory) {
 if(!hard.DEBUG && !hard.TELEDEBUG)
  return;

 let array = messages.split("\n");
 if(!array[array.length - 1])
  array.pop();
 for(let i = 0; i < array.length; i++)
  trace(id + " | " + array[i], mandatory);
}

function constrain(n, nMin, nMax) {
 if(n > nMax)
  n = nMax;
 else if(n < nMin)
  n = nMin;

 return n;
}

function sigterm(name, process, callback) {
 trace("Sending the SIGTERM signal to the process " + name, false);
 let processkill = EXEC("/usr/bin/pkill -15 -f ^" + process);
 processkill.on("close", function(code) {
  callback(code);
 });
}

function exec(name, command, callback) {
 trace("Starting the process " + name, false);
 trace(command, false);
 let proc = EXEC(command);
 let stdout = RL.createInterface(proc.stdout);
 let stderr = RL.createInterface(proc.stderr);
 let pid = proc.pid;
 let execTime = Date.now();

 //proc.stdout.on("data", function(data) {
 stdout.on("line", function(data) {
  traces(name + " | " + pid + " | stdout", data);
 });

 //proc.stderr.on("data", function(data) {
 stderr.on("line", function(data) {
  traces(name + " | " + pid + " | stderr", data);
 });

 proc.on("close", function(code) {
  let elapsed = Date.now() - execTime;

  trace("The " + name + " process is stopped after " + elapsed + " milliseconds with the exit code " + code, false);
  callback(code);
 });
}

function wake(server) {
 if(up)
  return;

 if(!initDone) {
  trace("This robot is not initialized", true);
  return;
 }

 if(currentServer) {
  trace("This robot is already in use from the " + currentServer + " server", true);
  return;
 }

 trace("Robot wake", false);

 writeOutputs();

 if(hard.SNAPSHOTSINTERVAL) {
  sigterm("Raspistill", "raspistill", function(code) {
   diffusion();
  });
 } else
  diffusion();
 diffAudio();

 currentServer = server;
 up = true;
 engine = true;
}

function sigterms(callback) {
 let i = 0;

 function loop() {
  if(i == USER.CMDDIFFUSION.length) {
   callback();
   return;
  }
  sigterm("Diffusion" + i, USER.CMDDIFFUSION[i][0], loop);
  i++;
 }

 loop();
}

function sleep() {
 if(!up)
  return;

 trace("Robot sleep", false);

 for(let i = 0; i < conf.TX.COMMANDS16.length; i++)
  if(hard.COMMANDS16[i].SLEEP)
   floatTargets16[i] = conf.TX.COMMANDS16[i].INIT;

 for(let i = 0; i < conf.TX.COMMANDS8.length; i++)
  if(hard.COMMANDS8[i].SLEEP)
   floatTargets8[i] = conf.TX.COMMANDS8[i].INIT;

 for(let i = 0; i < conf.TX.COMMANDS1.length; i++)
  if(hard.COMMANDS1[i].SLEEP)
   floatTargets1[i] = conf.TX.COMMANDS1[i].INIT;

 sigterms(function() {
 });

 sigterm("DiffAudio", USER.CMDDIFFAUDIO[0], function() {
 });

 currentServer = "";
 up = false;
}

function configurationVideo(callback) {
 cmdDiffusion = USER.CMDDIFFUSION[confVideo.SOURCE].join("").replace(new RegExp("WIDTH", "g"), confVideo.WIDTH
                                                           ).replace(new RegExp("HEIGHT", "g"), confVideo.HEIGHT
                                                           ).replace(new RegExp("FPS", "g"), confVideo.FPS
                                                           ).replace(new RegExp("BITRATE", "g"), confVideo.BITRATE
                                                           ).replace(new RegExp("ROTATE", "g"), confVideo.ROTATE
                                                           ).replace(new RegExp("VIDEOLOCALPORT", "g"), SYS.VIDEOLOCALPORT);
 cmdDiffAudio = USER.CMDDIFFAUDIO.join("").replace(new RegExp("RECORDINGDEVICE", "g"), hard.RECORDINGDEVICE
                                         ).replace(new RegExp("AUDIOLOCALPORT", "g"), SYS.AUDIOLOCALPORT);

 trace("Initializing the Video4Linux configuration", false);

 let brightness;
 let contrast;
 if(contrastBoost) {
  brightness = confVideo.BRIGHTNESSBOOST;
  contrast = confVideo.CONTRASTBOOST;
 } else {
  brightness = confVideo.BRIGHTNESS;
  contrast = confVideo.CONTRAST;
 }

 exec("v4l2-ctl", SYS.V4L2 + " -v width=" + confVideo.WIDTH +
                                ",height=" + confVideo.HEIGHT +
                                ",pixelformat=4" +
                             " -p " + confVideo.FPS +
                             " -c h264_profile=0" +
                                ",repeat_sequence_header=1" +
                                ",rotate=" + confVideo.ROTATE +
                                ",video_bitrate=" + confVideo.BITRATE +
                                ",brightness=" + brightness +
                                ",contrast=" + contrast, function() {
  callback();
 });
}

function diffusion() {
 trace("Starting the H.264 video broadcast stream", false);
 exec("Diffusion", cmdDiffusion, function() {
  trace("Stopping the H.264 video broadcast stream", false);
 });
}

function diffAudio() {
 trace("Starting the audio broadcast stream", false);
 exec("DiffAudio", cmdDiffAudio, function() {
  trace("Stopping the audio broadcast stream", false);
 });
}

function actions(trx) {
 for(let i = 0; i < conf.TX.COMMANDS16.length; i++)
  floatTargets16[i] = trx.getFloatCommand16(i);

 for(let i = 0; i < conf.TX.COMMANDS8.length; i++)
  floatTargets8[i] = trx.getFloatCommand8(i);

 for(let i = 0; i < conf.TX.COMMANDS1.length; i++)
  floatTargets1[i] = trx.getCommand1(i);

 contrastBoost = trx.getCommand1(hard.CONTRASTBOOSTSWITCH);
 if(contrastBoost != oldContrastBoost) {
  if(contrastBoost) {
   exec("v4l2-ctl", SYS.V4L2 + " -c brightness=" + confVideo.BRIGHTNESSBOOST +
                                  ",contrast=" + confVideo.CONTRASTBOOST, function() {
   });
  } else {
   exec("v4l2-ctl", SYS.V4L2 + " -c brightness=" + confVideo.BRIGHTNESS +
                                  ",contrast=" + confVideo.CONTRAST, function() {
   });
  }
  oldContrastBoost = contrastBoost;
 }
}

function initOutputs() {
 gpioOutputs.forEach(function(gpios) {
  gpios.forEach(function(gpio) {
   gpio.mode(GPIO.INPUT);
  });
 });

 pca9685Driver = [];
 gpioOutputs = [];
 initPca = 0;
 setInit();

 if(initPcaLock == 0) {
  initPcaLock = hard.PCA9685ADDRESSES.length;
  for(let i = 0; i < hard.PCA9685ADDRESSES.length; i++) {
   pca9685Driver[i] = new PCA9685.Pca9685Driver({
    i2c: i2c,
    address: hard.PCA9685ADDRESSES[i],
    frequency: SYS.PCA9685FREQUENCY
   }, function(err) {
    if(err)
     trace("Error initializing PCA9685 at address " + hard.PCA9685ADDRESSES[i], true);
    else {
     trace("PCA9685 initialized at address " + hard.PCA9685ADDRESSES[i], true);
     initPca++;
     setInit();
    }
    initPcaLock--;
   });
  }
 }

 for(let i = 0; i < hard.OUTPUTS.length; i++) {
  if(hard.OUTPUTS[i].ADRESSE == SYS.UNUSED) {
   gpioOutputs[i] = [];
   for(let j = 0; j < hard.OUTPUTS[i].GPIOS.length; j++)
    gpioOutputs[i][j] = new GPIO(hard.OUTPUTS[i].GPIOS[j], {mode: GPIO.OUTPUT});
   setMotorFrequency(i);
  }
 }

 for(let i = 0; i < conf.TX.COMMANDS16.length; i++) {
  floatTargets16[i] = conf.TX.COMMANDS16[i].INIT;
  floatCommands16[i] = floatTargets16[i];
  margins16[i] = (conf.TX.COMMANDS16[i].SCALEMAX - conf.TX.COMMANDS16[i].SCALEMIN) / 65535;
 }

 for(let i = 0; i < conf.TX.COMMANDS8.length; i++) {
  floatTargets8[i] = conf.TX.COMMANDS8[i].INIT;
  floatCommands8[i] = floatTargets8[i];
  margins8[i] = (conf.TX.COMMANDS8[i].SCALEMAX - conf.TX.COMMANDS8[i].SCALEMIN) / 255;
 }

 for(let i = 0; i < conf.TX.COMMANDS1.length; i++) {
  floatTargets1[i] = conf.TX.COMMANDS1[i].INIT;
  floatCommands1[i] = floatTargets1[i];
 }

 for(let i = 0; i < hard.OUTPUTS.length; i++) {
  oldOutputs[i] = 0;
  backslashs[i] = 0;
 }
}

USER.SERVERS.forEach(function(server, index) {

 sockets[server].on("connect", function() {
  trace("Connected to " + server + "/" + SYS.SECUREMOTEPORT, true);
  EXEC("hostname -I").stdout.on("data", function(ipPriv) {
   EXEC("iwgetid -r || echo $?").stdout.on("data", function(ssid) {
    sockets[server].emit("serveurrobotlogin", {
     conf: USER,
     version: VERSION,
     processTime: PROCESSTIME,
     osTime: OSTIME,
     ipPriv: ipPriv.trim(),
     ssid: ssid.trim()
    });
   });
  });
 });

 if(index == 0) {
  sockets[server].on("clientsrobotconf", function(data) {
   trace("Receiving robot configuration data from the " + server + " server", true);

   // Security hardening: even if already done on server side,
   // always filter values integrated in command lines
   const CMDINT = RegExp(/^-?\d{1,10}$/);
   for(let i = 0; i < data.hard.CAMERAS.length; i++) {
    if(!(CMDINT.test(data.hard.CAMERAS[i].SOURCE) &&
         CMDINT.test(data.hard.CAMERAS[i].WIDTH) &&
         CMDINT.test(data.hard.CAMERAS[i].HEIGHT) &&
         CMDINT.test(data.hard.CAMERAS[i].FPS) &&
         CMDINT.test(data.hard.CAMERAS[i].BITRATE) &&
         CMDINT.test(data.hard.CAMERAS[i].ROTATE) &&
         CMDINT.test(data.hard.CAMERAS[i].BRIGHTNESS) &&
         CMDINT.test(data.hard.CAMERAS[i].CONTRAST) &&
         CMDINT.test(data.hard.CAMERAS[i].BRIGHTNESSBOOST) &&
         CMDINT.test(data.hard.CAMERAS[i].CONTRASTBOOST)))
     return;
   }
   if(!(CMDINT.test(data.hard.WLANDEVICE) &&
        CMDINT.test(data.hard.RECORDINGDEVICE) &&
        CMDINT.test(data.hard.PLAYBACKDEVICE)))
    return;

   conf = data.conf;
   hard = data.hard;

   tx = new FRAME.Tx(conf.TX);
   rx = new FRAME.Rx(conf.TX, conf.RX);

   confVideo = hard.CAMERAS[conf.COMMANDS[conf.DEFAULTCOMMAND].CAMERA];
   oldConfVideo = confVideo;
   contrastBoost = false;
   oldContrastBoost = false;

   autopilot = false;
   for(let i = 0; i < hard.CAMERAS.length; i++) {
    if(hard.CAMERAS[i].TYPE == "Autopilot") {
     autopilot = true;
     break;
    }
   }

   initOutputs();
   if(!up)
    writeOutputs();

   setTimeout(function() {
    if(!up)
     setSleepModes();
   }, 100);

   setTimeout(function() {
    if(up) {
     sigterms(function() {
      configurationVideo(function() {
       diffusion();
      });
     });
    } else {
     configurationVideo(function() {
      initVideo = true;
      setInit();
     });
    }
   }, 200);


   //1. make sure bluetooth is enabled in /boot/config.txt . should look like this:
   //  #dtoverlay=pi3-disable-bt
   //  (bluetooth uses UART for communication)
   //2. sudo systemctl enable hciuart.service and reboot
   //if those requirements are not met, any usage of noble will throw an error
   if (hard.BLEMAC === "" || hard.BLEMAC === 0) {
    console.log(`BLE inactive. Bluetooth in /boot/config.txt disabled, hciuart.service not running, or MAC address not set`);
   } else {
    //start BLE scan
    noble.on('stateChange', function (state) {
     if (state === 'poweredOn') {
      noble.startScanning([], true) //allows duplicates while scanning
     } else {
      noble.stopScanning();
     }
    });

    //function constatly searches for the specified BLE MAC address, and captures its RSSI value
    noble.on('discover', function (peripheral) {
     if (peripheral.id === hard.BLEMAC.toLowerCase() || peripheral.address === hard.BLEMAC.toLowerCase()) {
      bleRssi = peripheral.rssi;
      console.log(`BLE update. Name:${peripheral.advertisement.localName} RSSI:${peripheral.rssi} txP:${peripheral.advertisement.txPowerLevel}`);
     }
    });
   }


   if(initUart)
    return;

   if(hard.WRITEUSERDEVICE == SYS.UNUSED && hard.ENABLEGPS == SYS.UNUSED) {
    initUart = true;
    setInit();

   } else if(hard.WRITEUSERDEVICE != SYS.UNUSED) {
    serial = new SP(hard.SERIALPORTS[hard.WRITEUSERDEVICE], {
     baudRate: hard.SERIALRATES[hard.WRITEUSERDEVICE],
     lock: false
    });

    serial.on("open", function() {
     trace("Connected to " + hard.SERIALPORTS[hard.WRITEUSERDEVICE], true);

     if(hard.READUSERDEVICE != SYS.UNUSED) {
      serial.on("data", function(data) {

       rx.update(data, function() {

        if(hard.CAMERAS[rx.cameraChoices[0]].TYPE == "Autopilot")
         actions(rx);

        setRxValues();
        USER.SERVERS.forEach(function(server) {
         if(currentServer && server != currentServer)
          return;

         sockets[server].emit("serveurrobotrx", {
          timestamp: Date.now(),
          data: rx.arrayBuffer
         });
        });
       }, function(err) {
        trace(err, false);
       });

      });
     }

     initUart = true;
     setInit();
    });
   }

   if(hard.ENABLEGPS != SYS.UNUSED) {
    serialGps = new SP(hard.SERIALPORTS[hard.ENABLEGPS], {
     baudRate: hard.SERIALRATES[hard.ENABLEGPS],
     lock: false,
     parser: new SP.parsers.Readline("\r\n")
    });

    serialGps.on("open", function() {
     trace("Connected to " + hard.SERIALPORTS[hard.ENABLEGPS], true);

     gps = new GPS;

     serialGps.on("data", function(data) {
      gps.updatePartial(data);
     });

     initUart = true;
     setInit();
    });
   }

  });
 }

 sockets[server].on("disconnect", function() {
  trace("Disconnected from " + server + "/" + SYS.SECUREMOTEPORT, true);
  sleep();
 });

 sockets[server].on("connect_error", function(err) {
  //trace("Error connecting to " + server + "/" + SYS.SECUREMOTEPORT, false);
 });

 sockets[server].on("clientsrobottts", function(data) {
  FS.writeFile("/tmp/tts.txt", data, function(err) {
   if(err)
    trace(err, false);
   exec("eSpeak", USER.CMDTTS.replace(new RegExp("PLAYBACKDEVICE", "g"), hard.PLAYBACKDEVICE), function() {
   });
  });
 });

 sockets[server].on("clientsrobotsys", function(data) {
  switch(data) {
   case "exit":
    trace("Restart the client process", true);
    process.exit();
    break;
   case "reboot":
    trace("Restart the system", true);
    EXEC("reboot");
    break;
   case "poweroff":
    trace("Power off the system", true);
    EXEC("poweroff");
    break;
  }
 });

 sockets[server].on("echo", function(data) {
  sockets[server].emit("echo", {
   serveur: data,
   client: Date.now()
  });
 });

 sockets[server].on("clientsrobottx", function(data) {
  if(currentServer && server != currentServer || !initDone)
   return;

  if(data.data[0] != FRAME0 ||
     data.data[1] != FRAME1S &&
     data.data[1] != FRAME1T) {
   trace("Reception of a corrupted frame", false);
   return;
  }

  // Reject bursts
  let now = Date.now();
  if(now - lastFrame < SYS.TXRATE / 2)
   return;
  lastFrame = now;

  lastTimestamp = data.boucleVideoCommande;

  if(hard.WRITEUSERDEVICE != SYS.UNUSED)
   serial.write(data.data);

  if(data.data[1] == FRAME1S) {
   for(let i = 0; i < tx.byteLength; i++)
    tx.bytes[i] = data.data[i];

   if(hard.CAMERAS[tx.cameraChoices[0]].TYPE != "Autopilot")
    actions(tx);

   confVideo = hard.CAMERAS[tx.cameraChoices[0]];
   if(confVideo != oldConfVideo &&
      JSON.stringify(confVideo) != JSON.stringify(oldConfVideo)) {
    if(up) {
     sigterms(function() {
      configurationVideo(function() {
       diffusion();
      });
     });
    } else {
     configurationVideo(function() {
     });
    }
    oldConfVideo = confVideo;
   }

  } else
   trace("Reception of a text frame", false);

  wake(server);
  clearTimeout(upTimeout);
  upTimeout = setTimeout(function() {
   sleep();
  }, SYS.UPTIMEOUT);

  if(hard.READUSERDEVICE == SYS.UNUSED ||
     autopilot && hard.CAMERAS[tx.cameraChoices[0]].TYPE != "Autopilot") {
   setRxCommands();
   setRxValues();
   sockets[server].emit("serveurrobotrx", {
    timestamp: now,
    data: rx.arrayBuffer
   });
  }
 });
});

function computeOut(n, value) {
 let out;
 let nbInMax = hard.OUTPUTS[n].INS.length - 1;

 if(value <= hard.OUTPUTS[n].INS[0])
  out = hard.OUTPUTS[n].OUTS[0];
 else if(value > hard.OUTPUTS[n].INS[nbInMax])
  out = hard.OUTPUTS[n].OUTS[nbInMax];
 else {
  for(let i = 0; i < nbInMax; i++) {
   if(value <= hard.OUTPUTS[n].INS[i + 1]) {
    out = map(value, hard.OUTPUTS[n].INS[i], hard.OUTPUTS[n].INS[i + 1], hard.OUTPUTS[n].OUTS[i], hard.OUTPUTS[n].OUTS[i + 1]);
    break;
   }
  }
 }

 return out;
}

function setMotorFrequency(n) {
 if(hard.OUTPUTS[n].ADRESSE == SYS.UNUSED) {
  switch(hard.OUTPUTS[n].TYPE) {
   case "Pwms":
    for(let i = 0; i < gpioOutputs[n].length; i++)
     gpioOutputs[n][i].pwmFrequency(hard.PWMFREQUENCY);
    break;
   case "PwmPwm":
    gpioOutputs[n][0].pwmFrequency(hard.PWMFREQUENCY);
    gpioOutputs[n][1].pwmFrequency(hard.PWMFREQUENCY);
    break;
   case "PwmDir":
    gpioOutputs[n][0].pwmFrequency(hard.PWMFREQUENCY);
    break;
   case "PwmDirDir":
    gpioOutputs[n][0].pwmFrequency(hard.PWMFREQUENCY);
    break;
  }
 }
}

function setGpio(n, pin, etat) {
 let pcaId = hard.OUTPUTS[n].ADRESSE;
 let gpio;

 if(pcaId == SYS.UNUSED) {
  gpio = gpioOutputs[n][pin];
  if(etat == SYS.INPUT)
   gpio.mode(GPIO.INPUT);
  else
   gpio.digitalWrite(etat);
 } else {
  gpio = hard.OUTPUTS[n].GPIOS[pin];
  if(etat)
   pca9685Driver[pcaId].channelOn(gpio);
  else
   pca9685Driver[pcaId].channelOff(gpio);
 }
}

function setGpios(n, value) {
 let etat = computeOut(n, value);

 for(let i = 0; i < hard.OUTPUTS[n].GPIOS.length; i++)
  setGpio(n, i, etat);
}

function setServos(n, value) {
 let pwm = computeOut(n, value);
 let pcaId = hard.OUTPUTS[n].ADRESSE;

 if(pcaId == SYS.UNUSED)
  for(let i = 0; i < hard.OUTPUTS[n].GPIOS.length; i++)
   gpioOutputs[n][i].servoWrite(pwm);
 else
  for(let i = 0; i < hard.OUTPUTS[n].GPIOS.length; i++)
   pca9685Driver[hard.OUTPUTS[n].ADRESSE].setPulseLength(hard.OUTPUTS[n].GPIOS[i], pwm);
}

function setPwm(n, gpio, pwm) {
 let pcaId = hard.OUTPUTS[n].ADRESSE;

 if(pcaId == SYS.UNUSED)
  gpioOutputs[n][gpio].pwmWrite(Math.abs(map(pwm, -100, 100, -255, 255)));
 else
  pca9685Driver[pcaId].setDutyCycle(hard.OUTPUTS[n].GPIOS[gpio], Math.abs(pwm / 100));
}

function setPwms(n, value) {
 let pwm = computeOut(n, value);

 for(let i = 0; i < hard.OUTPUTS[n].GPIOS.length; i++)
  setPwm(n, i, pwm);
}

function setPwmPwm(n, value) {
 let pwm = computeOut(n, value);

 if(pwm > 0) {
  setPwm(n, 0, pwm);
  setGpio(n, 1, 0);
 } else if(pwm < 0) {
  setGpio(n, 0, 0);
  setPwm(n, 1, pwm);
 } else {
  setGpio(n, 0, 1);
  setGpio(n, 1, 1);
 }
}

function setPwmDir(n, value) {
 let pwm = computeOut(n, value);

 if(pwm > 0)
  setGpio(n, 1, 1);
 else
  setGpio(n, 1, 0);
 setPwm(n, 0, pwm);
}

function setPwmDirDir(n, value) {
 let pwm = computeOut(n, value);

 if(pwm > 0) {
  setGpio(n, 1, 1);
  setGpio(n, 2, 0);
 } else if(pwm < 0) {
  setGpio(n, 1, 0);
  setGpio(n, 2, 1);
 } else {
  setGpio(n, 1, 1);
  setGpio(n, 2, 1);
 }
 setPwm(n, 0, pwm);
}

function writeOutputs() {
 for(let i = 0; i < hard.OUTPUTS.length; i++) {

  let output = 0;

  for(let j = 0; j < hard.OUTPUTS[i].COMMANDS16.length; j++)
   output += floatCommands16[hard.OUTPUTS[i].COMMANDS16[j]] * hard.OUTPUTS[i].GAINS16[j];
  for(let j = 0; j < hard.OUTPUTS[i].COMMANDS8.length; j++)
   output += floatCommands8[hard.OUTPUTS[i].COMMANDS8[j]] * hard.OUTPUTS[i].GAINS8[j];
  for(let j = 0; j < hard.OUTPUTS[i].COMMANDS1.length; j++)
   output += floatCommands1[hard.OUTPUTS[i].COMMANDS1[j]] * hard.OUTPUTS[i].GAINS1[j];

  if(output < oldOutputs[i])
   backslashs[i] = -hard.OUTPUTS[i].BACKSLASH;
  else if(output > oldOutputs[i])
   backslashs[i] = hard.OUTPUTS[i].BACKSLASH;

  oldOutputs[i] = output;

  let value = output + backslashs[i];

  switch(hard.OUTPUTS[i].TYPE) {
   case "Gpios":
    setGpios(i, value);
    break;
   case "Servos":
    setServos(i, value);
    break;
   case "Pwms":
    setPwms(i, value);
    break;
   case "PwmPwm":
    setPwmPwm(i, value);
    break;
   case "PwmDir":
    setPwmDir(i, value);
    break;
   case "PwmDirDir":
    setPwmDirDir(i, value);
    break;
  }
 }
}

function setSleepModes() {
 for(let i = 0; i < hard.OUTPUTS.length; i++) {
  let pcaId = hard.OUTPUTS[i].ADRESSE;
  let etat;
  for(let j = 0; j < hard.OUTPUTS[i].SLEEPMODES.length; j++) {
   let sleepMode = hard.OUTPUTS[i].SLEEPMODES[j];
   if(sleepMode == "None")
    continue;
   if(sleepMode == "High")
    etat = 1;
   else if(sleepMode == "Low")
    etat = 0;
   else
    etat = 2;
   setGpio(i, j, etat);
  }
 }
}

setInterval(function() {
 if(!engine)
  return;

 let change = false;
 let predictiveLatency = Date.now() - lastTimestamp;

 if(predictiveLatency < SYS.LATENCYALARMEND && latencyAlarm) {
  trace(predictiveLatency + " ms latency, resuming normal operations", false);
  latencyAlarm = false;
 } else if(predictiveLatency > SYS.LATENCYALARMBEGIN && !latencyAlarm) {
  trace(predictiveLatency + " ms latency, stopping of motors and streams", false);
  latencyAlarm = true;
 }

 if(latencyAlarm) {
  for(let i = 0; i < conf.TX.COMMANDS16.length; i++)
   if(hard.COMMANDS16[i].FAILSAFE)
    floatTargets16[i] = conf.TX.COMMANDS16[i].INIT;

  for(let i = 0; i < conf.TX.COMMANDS8.length; i++)
   if(hard.COMMANDS8[i].FAILSAFE)
    floatTargets8[i] = conf.TX.COMMANDS8[i].INIT;

  for(let i = 0; i < conf.TX.COMMANDS1.length; i++)
   if(hard.COMMANDS1[i].FAILSAFE)
    floatTargets1[i] = conf.TX.COMMANDS1[i].INIT;
 }

 for(let i = 0; i < conf.TX.COMMANDS16.length; i++) {
  if(floatCommands16[i] == floatTargets16[i])
   continue;
  change = true;

  let delta;
  let target = floatTargets16[i];
  let init = conf.TX.COMMANDS16[i].INIT;

  if(Math.abs(target - init) <= margins16[i])
   delta = hard.COMMANDS16[i].RAMPINIT;
  else if((target - init) * (floatCommands16[i] - init) < 0) {
   delta = hard.COMMANDS16[i].RAMPDOWN;
   target = init;
  } else if(Math.abs(target) - Math.abs(floatCommands16[i]) < 0)
   delta = hard.COMMANDS16[i].RAMPDOWN;
  else
   delta = hard.COMMANDS16[i].RAMPUP;

  if(delta <= 0)
   floatCommands16[i] = target;
  else if(floatCommands16[i] - target < -delta)
   floatCommands16[i] += delta;
  else if(floatCommands16[i] - target > delta)
   floatCommands16[i] -= delta;
  else
   floatCommands16[i] = target;
 }

 for(let i = 0; i < conf.TX.COMMANDS8.length; i++) {
  if(floatCommands8[i] == floatTargets8[i])
   continue;
  change = true;

  let delta;
  let target = floatTargets8[i];
  let init = conf.TX.COMMANDS8[i].INIT;

  if(Math.abs(target - init) <= margins8[i])
   delta = hard.COMMANDS8[i].RAMPINIT;
  else if((target - init) * (floatCommands8[i] - init) < 0) {
   delta = hard.COMMANDS8[i].RAMPDOWN;
   target = init;
  } else if(Math.abs(target) - Math.abs(floatCommands8[i]) < 0)
   delta = hard.COMMANDS8[i].RAMPDOWN;
  else
   delta = hard.COMMANDS8[i].RAMPUP;

  if(delta <= 0)
   floatCommands8[i] = target;
  else if(floatCommands8[i] - target < -delta)
   floatCommands8[i] += delta;
  else if(floatCommands8[i] - target > delta)
   floatCommands8[i] -= delta;
  else
   floatCommands8[i] = target;
 }

 for(let i = 0; i < conf.TX.COMMANDS1.length; i++) {
  if(floatCommands1[i] == floatTargets1[i])
   continue;
  change = true;

  let delta;
  if(Math.abs(floatTargets1[i] - conf.TX.COMMANDS1[i].INIT) < 1)
   delta = hard.COMMANDS1[i].RAMPINIT;
  else
   delta = hard.COMMANDS1[i].RAMPUP;

  if(delta <= 0)
   floatCommands1[i] = floatTargets1[i];
  else if(floatTargets1[i] - floatCommands1[i] > delta)
   floatCommands1[i] += delta;
  else if(floatTargets1[i] - floatCommands1[i] < -delta)
   floatCommands1[i] -= delta;
  else
   floatCommands1[i] = floatTargets1[i];
 }

 if(change)
  writeOutputs();
 else if(!up) {
  setSleepModes();
  engine = false;
 }
}, SYS.SERVORATE);

setInterval(function() {
 if(!initDone)
  return;

 let currCpus = OS.cpus();
 let charges = 0;
 let idles = 0;

 for(let i = 0; i < nbCpus; i++) {
  let prevCpu = prevCpus[i];
  let currCpu = currCpus[i];

  charges += currCpu.times.user - prevCpu.times.user;
  charges += currCpu.times.nice - prevCpu.times.nice;
  charges += currCpu.times.sys - prevCpu.times.sys;
  charges += currCpu.times.irq - prevCpu.times.irq;
  idles += currCpu.times.idle - prevCpu.times.idle;
 }
 prevCpus = currCpus;

 cpuLoad = Math.trunc(100 * charges / (charges + idles));
}, SYS.CPURATE);

setInterval(function() {
 if(!initDone)
  return;

 FS.readFile(SYS.TEMPFILE, function(err, data) {
  socTemp = data / 1000;
 });
}, SYS.TEMPRATE);

setInterval(function() {
 if(!initDone)
  return;

 const STATS = RL.createInterface(FS.createReadStream(SYS.WIFIFILE));

 STATS.on("line", function(ligne) {
  ligne = ligne.split(/\s+/);

  if(ligne[1] == "wlan" + hard.WLANDEVICE + ":") {
   link = ligne[3];
   rssi = ligne[4];
  }
 });
}, SYS.WIFIRATE);

function swapWord(word) {
 return (word & 0xff) << 8 | word >> 8;
}

switch(gaugeType) {
 case "CW2015":
  setInterval(function() {
   if(!initDone)
    return;
   i2c.readWord(SYS.CW2015ADDRESS, 0x02, function(err, microVolts305) {
    voltage = swapWord(microVolts305) * 305 / 1000000;
    i2c.readWord(SYS.CW2015ADDRESS, 0x04, function(err, pour25600) {
     battery = swapWord(pour25600) / 256;
    });
   });
  }, SYS.GAUGERATE);
  break;

 case "MAX17043":
  setInterval(function() {
   if(!initDone)
    return;
   i2c.readWord(SYS.MAX17043ADDRESS, 0x02, function(err, volts12800) {
    voltage = swapWord(volts12800) / 12800;
    i2c.readWord(SYS.MAX17043ADDRESS, 0x04, function(err, pour25600) {
     battery = swapWord(pour25600) / 256;
    });
   });
  }, SYS.GAUGERATE);
  break;

 case "BQ27441":
  setInterval(function() {
   if(!initDone)
    return;
   i2c.readWord(SYS.BQ27441ADDRESS, 0x04, function(err, milliVolts) {
    voltage = milliVolts / 1000;
    i2c.readByte(SYS.BQ27441ADDRESS, 0x1c, function(err, pourcents) {
     battery = pourcents;
    });
   });
  }, SYS.GAUGERATE);
  break;
}

function setRxCommands() {
 for(let i = 0; i < conf.TX.COMMANDS16.length; i++)
  rx.commandsInt16[i] = tx.computeRawCommand16(i, floatCommands16[i]);
 rx.cameraChoices[0] = tx.cameraChoices[0];
 for(let i = 0; i < conf.TX.COMMANDS8.length; i++)
  rx.commandsInt8[i] = tx.computeRawCommand8(i, floatCommands8[i]);
 for(let i = 0; i < conf.TX.COMMANDS1.length / 8; i++) {
  let commande1 = 0;
  for(let j = 0; j < 8; j++)
   if(floatCommands1[i * 8 + j] > 0)
    commande1 += 1 << j;
  rx.commands1[i] = commande1;
 }
}

function setRxValues() {
 if(hard.ENABLEGPS != SYS.UNUSED && gps.state.lat !== null) {
  rx.setFloatValue32(0, gps.state.lat);
  rx.setFloatValue32(1, gps.state.lon);
 }
 rx.setFloatValue16(0, voltage);
 rx.setFloatValue16(1, battery);
 rx.setFloatValue8(0, cpuLoad);
 rx.setFloatValue8(1, socTemp);
 rx.setFloatValue8(2, link);
 rx.setFloatValue8(3, rssi);
 if(hard.ENABLEGPS != SYS.UNUSED) {
  if(typeof gps.state.satsActive !== "undefined")
   rx.setFloatValue8(4, gps.state.satsActive.length);
  rx.setFloatValue8(5, gps.state.speed);
  if(gps.state.track !== null)
   rx.setFloatValue8(6, gps.state.track);
 }
}

setInterval(function() {
 if(up || !initDone)
  return;

 setRxCommands();
 setRxValues();
 USER.SERVERS.forEach(function(server) {
  sockets[server].emit("serveurrobotrx", {
   timestamp: Date.now(),
   data: rx.arrayBuffer
  });
 });
}, SYS.BEACONRATE);

setInterval(function() {
 if(up || !initDone || !hard.SNAPSHOTSINTERVAL)
  return;

 let date = new Date();

 if(date.getMinutes() % hard.SNAPSHOTSINTERVAL)
  return;

 let overlay = date.toLocaleDateString() + " " + date.toLocaleTimeString();
 if(hard.EXPOSUREBRACKETING)
  overlay += " HDR " + hard.EXPOSUREBRACKETING;
 let options = "-a 1024 -a '" + overlay + "' -rot " + confVideo.ROTATE;

 if(hard.EXPOSUREBRACKETING) {
  EXEC("raspistill -ev " + -hard.EXPOSUREBRACKETING + " " + options + " -o /tmp/1.jpg", function(err) {
   if(err) {
    trace("Error while capturing the first photo", false);
    return;
   }
   EXEC("raspistill " + options + " -o /tmp/2.jpg", function(err) {
    if(err) {
     trace("Error while capturing the second photo", false);
     return;
    }
    EXEC("raspistill -ev " + hard.EXPOSUREBRACKETING + " " + options + " -o /tmp/3.jpg", function(err) {
     if(err) {
      trace("Error while capturing the third photo", false);
      return;
     }
     EXEC("enfuse -o /tmp/out.jpg /tmp/1.jpg /tmp/2.jpg /tmp/3.jpg", function(err) {
      if(err)
       trace("Error when merging photos", false);
      else {
       FS.readFile("/tmp/out.jpg", function(err, data) {
        USER.SERVERS.forEach(function(server) {
         trace("Uploading a photo to the server " + server, false);
         sockets[server].emit("serveurrobotcapturesenveille", data);
        });
       });
      }
     });
    });
   });
  });
 } else {
  EXEC("raspistill -q 10 " + options + " -o /tmp/out.jpg", function(err) {
   if(err)
    trace("Error while capturing the photo", false);
   else {
    FS.readFile("/tmp/out.jpg", function(err, data) {
     USER.SERVERS.forEach(function(server) {
      trace("Uploading a photo to the server " + server, false);
      sockets[server].emit("serveurrobotcapturesenveille", data);
     });
    });
   }
  });
 }
}, 60000);

NET.createServer(function(socket) {
 const SEPARATEURNALU = new Buffer.from([0, 0, 0, 1]);
 const SPLITTER = new SPLIT(SEPARATEURNALU);

 trace("H.264 video streaming process is connected to tcp://127.0.0.1:" + SYS.VIDEOLOCALPORT, false);

 SPLITTER.on("data", function(data) {

  if(currentServer) {
   if(latencyAlarm)
    data = new Buffer.from([]);
   sockets[currentServer].emit("serveurrobotvideo", {
    timestamp: Date.now(),
    data: data
   });
  }

 }).on("error", function(err) {
  trace("Error when splitting input stream into H.264 network abstraction layer units", false);
 });

 socket.pipe(SPLITTER);

 socket.on("end", function() {
  trace("H.264 video streaming process is disconnected from tcp://127.0.0.1:" + SYS.VIDEOLOCALPORT, false);
 });

}).listen(SYS.VIDEOLOCALPORT);

NET.createServer(function(socket) {

 trace("The audio streaming process is connected to tcp://127.0.0.1:" + SYS.AUDIOLOCALPORT, false);

 let array = [];
 let i = 0;
 socket.on("data", function(data) {

  array.push(data);
  i++;

  if(i == 20) {
   if(currentServer) {
    if(latencyAlarm)
     array = [];
    sockets[currentServer].emit("serveurrobotaudio", {
     timestamp: Date.now(),
     data: Buffer.concat(array)
    });
   }
   array = [];
   i = 0;
  }

 })

 socket.on("end", function() {
  trace("Audio streaming process is disconnected from tcp://127.0.0.1:" + SYS.AUDIOLOCALPORT, false);
 });

}).listen(SYS.AUDIOLOCALPORT);

function KernelExceptionWatchdog() {
 let proc = EXEC("dmesg");
 let stdout = RL.createInterface(proc.stdout);
 let once = false;

 stdout.on("line", function(data) {
  if(!once && data.indexOf("Exception stack") != -1) {
   trace("Following a Raspberry PI kernel " + OS.release() + " exception, the system will be restarted automatically", true);
   setTimeout(function() {
    EXEC("reboot");
   }, 1000);
   once = true;
  }
 });
}

setInterval(function() {
 if(!up)
  KernelExceptionWatchdog();
}, 10000);

process.on("uncaughtException", function(err) {
 let i = 0;
 let errors = err.stack.split("\n");

 while(i < errors.length)
  trace(errors[i++], false);

 trace("Following this uncaught exception, the Node.js process will be terminated automatically", true);
 setTimeout(function() {
  process.exit(1);
 }, 1000);
})

trace("Client ready", true);
