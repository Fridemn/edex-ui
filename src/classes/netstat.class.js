class Netstat {
    constructor(parentId) {
        if (!parentId) throw "Missing parameters";

        // Get modules from preload or direct require
        let https, pathModule, net, geolite2, maxmind, ipcSend;

        if (window.electronAPI && window.electronAPI.nodeModules) {
            https = window.electronAPI.nodeModules.https;
            pathModule = window.electronAPI.nodeModules.path;
            net = window.electronAPI.nodeModules.net;
            geolite2 = window.electronAPI.geolite2;
            maxmind = window.electronAPI.maxmind;
            ipcSend = window.electronAPI.ipcSend;
        } else {
            https = require('https');
            pathModule = require('path');
            net = require('net');
            try {
                geolite2 = require('geolite2-redist');
                maxmind = require('maxmind');
            } catch(e) {
                geolite2 = null;
                maxmind = null;
            }
            const electron = require('electron');
            ipcSend = (channel, type, msg) => electron.ipcRenderer.send(channel, type, msg);
        }
        this._ipcSend = ipcSend;

        // Create DOM
        this.parent = document.getElementById(parentId);
        this.parent.innerHTML += `<div id="mod_netstat">
            <div id="mod_netstat_inner">
                <h1>NETWORK STATUS<i id="mod_netstat_iname"></i></h1>
                <div id="mod_netstat_innercontainer">
                    <div>
                        <h1>STATE</h1>
                        <h2>UNKNOWN</h2>
                    </div>
                    <div>
                        <h1>IPv4</h1>
                        <h2>--.--.--.--</h2>
                    </div>
                    <div>
                        <h1>PING</h1>
                        <h2>--ms</h2>
                    </div>
                </div>
            </div>
        </div>`;

        this.offline = false;
        this.lastconn = {finished: false}; // Prevent geoip lookup attempt until maxminddb is loaded
        this.iface = null;
        this.failedAttempts = {};
        this.runsBeforeGeoIPUpdate = 0;

        this._httpsAgent = new https.Agent({
            keepAlive: false,
            maxSockets: 10
        });

        // Init updaters
        this.updateInfo();
        this.infoUpdater = setInterval(() => {
            this.updateInfo();
        }, 2000);

        // Init GeoIP integrated backend
        this.geoLookup = {
            get: () => null
        };

        // Get userData path via IPC or direct
        const initGeoIP = (userDataPath) => {
            if (geolite2 && maxmind) {
                geolite2.downloadDbs(pathModule.join(userDataPath, "geoIPcache")).then(() => {
                    geolite2.open('GeoLite2-City', dbPath => {
                        return maxmind.open(dbPath);
                    }).catch(e => {throw e}).then(lookup => {
                        this.geoLookup = lookup;
                        this.lastconn.finished = true;
                    });
                });
            }
        };

        if (window.electronAPI && window.electronAPI.app) {
            window.electronAPI.app.getPath('userData').then(userDataPath => {
                initGeoIP(userDataPath);
            }).catch(e => {
                console.warn('GeoIP initialization failed:', e);
            });
        } else {
            const remote = require('@electron/remote');
            initGeoIP(remote.app.getPath('userData'));
        }
    }
    updateInfo() {
        window.si.networkInterfaces().then(async data => {
            let offline = false;

            let net = data[0];
            let netID = 0;

            if (typeof window.settings.iface === "string") {
                while (net.iface !== window.settings.iface) {
                    netID++;
                    if (data[netID]) {
                        net = data[netID];
                    } else {
                        // No detected interface has the custom iface name, fallback to automatic detection on next loop
                        window.settings.iface = false;
                        return false;
                    }
                }
            } else {
                // Find the first external, IPv4 connected networkInterface that has a MAC address set

                while (net.operstate !== "up" || net.internal === true || net.ip4 === "" || net.mac === "") {
                    netID++;
                    if (data[netID]) {
                        net = data[netID];
                    } else {
                        // No external connection!
                        this.iface = null;
                        document.getElementById("mod_netstat_iname").innerText = "Interface: (offline)";

                        this.offline = true;
                        document.querySelector("#mod_netstat_innercontainer > div:first-child > h2").innerHTML = "OFFLINE";
                        document.querySelector("#mod_netstat_innercontainer > div:nth-child(2) > h2").innerHTML = "--.--.--.--";
                        document.querySelector("#mod_netstat_innercontainer > div:nth-child(3) > h2").innerHTML = "--ms";
                        break;
                    }
                }
            }

            if (net.ip4 !== this.internalIPv4) this.runsBeforeGeoIPUpdate = 0;

            this.iface = net.iface;
            this.internalIPv4 = net.ip4;
            document.getElementById("mod_netstat_iname").innerText = "Interface: "+net.iface;

            if (net.ip4 === "127.0.0.1") {
                offline = true;
            } else {
                if (this.runsBeforeGeoIPUpdate === 0 && this.lastconn.finished) {
                    this.lastconn = https.get({host: "myexternalip.com", port: 443, path: "/json", localAddress: net.ip4, agent: this._httpsAgent}, res => {
                        let rawData = "";
                        res.on("data", chunk => {
                            rawData += chunk;
                        });
                        res.on("end", () => {
                            try {
                                let data = JSON.parse(rawData);
                                this.ipinfo = {
                                    ip: data.ip,
                                    geo: this.geoLookup.get(data.ip).location
                                };

                                let ip = this.ipinfo.ip;
                                document.querySelector("#mod_netstat_innercontainer > div:nth-child(2) > h2").innerHTML = window._escapeHtml(ip);

                                this.runsBeforeGeoIPUpdate = 10;
                            } catch(e) {
                                this.failedAttempts[e] = (this.failedAttempts[e] || 0) + 1;
                                if (this.failedAttempts[e] > 2) return false;
                                console.warn(e);
                                console.info(rawData.toString());
                                this._ipcSend("log", "note", "NetStat: Error parsing data from myexternalip.com");
                                this._ipcSend("log", "debug", `Error: ${e}`);
                            }
                        });
                    }).on("error", e => {
                        // Drop it
                    });
                } else if (this.runsBeforeGeoIPUpdate !== 0) {
                    this.runsBeforeGeoIPUpdate = this.runsBeforeGeoIPUpdate - 1;
                }

                let p = await this.ping(window.settings.pingAddr || "1.1.1.1", 80, net.ip4).catch(() => { offline = true });

                this.offline = offline;
                if (offline) {
                    document.querySelector("#mod_netstat_innercontainer > div:first-child > h2").innerHTML = "OFFLINE";
                    document.querySelector("#mod_netstat_innercontainer > div:nth-child(2) > h2").innerHTML = "--.--.--.--";
                    document.querySelector("#mod_netstat_innercontainer > div:nth-child(3) > h2").innerHTML = "--ms";
                } else {
                    document.querySelector("#mod_netstat_innercontainer > div:first-child > h2").innerHTML = "ONLINE";
                    document.querySelector("#mod_netstat_innercontainer > div:nth-child(3) > h2").innerHTML = Math.round(p)+"ms";
                }
            }
        });
    }
    ping(target, port, local) {
        return new Promise((resolve, reject) => {
            let s = new net.Socket();
            let start = performance.now();

            s.connect({
                port,
                host: target,
                localAddress: local,
                family: 4
            }, () => {
                let time = performance.now() - start;
                resolve(time);
                s.destroy();
            });
            s.on('error', e => {
                s.destroy();
                reject(e);
            });
            s.setTimeout(1900, function() {
                s.destroy();
                reject(new Error("Socket timeout"));
            });
        });
    }
}

module.exports = {
    Netstat
};
