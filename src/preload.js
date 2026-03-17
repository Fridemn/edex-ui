/**
 * Preload script for Electron 33+
 * Exposes secure APIs to the renderer process via contextBridge
 */

const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const net = require('net');
const childProcess = require('child_process');
const os = require('os');

// Import xterm and addons for browser context
let xtermModule, xtermAttach, xtermFit, xtermLigatures, xtermWebgl;
try {
    xtermModule = require('xterm');
    xtermAttach = require('xterm-addon-attach');
    xtermFit = require('xterm-addon-fit');
    xtermLigatures = require('xterm-addon-ligatures');
    xtermWebgl = require('xterm-addon-webgl');
} catch (e) {
    console.warn('xterm modules not available in preload:', e);
}

// Import color module for terminal
let colorModule;
try {
    colorModule = require('color');
} catch (e) {
    console.warn('color module not available in preload:', e);
}

// Import GeoIP modules for netstat
let geolite2, maxmind;
try {
    geolite2 = require('geolite2-redist');
    maxmind = require('maxmind');
} catch (e) {
    console.warn('GeoIP modules not available in preload:', e);
}

// Valid IPC channels for security
const validInvokeChannels = [
    'app:getVersion',
    'app:getPath',
    'app:quit',
    'app:relaunch',
    'app:focus',
    'app:getCommandLineArgs',
    'window:minimize',
    'window:maximize',
    'window:setSize',
    'window:getSize',
    'window:setFullScreen',
    'window:isFullScreen',
    'window:toggleDevTools',
    'window:reload',
    'clipboard:readText',
    'clipboard:writeText',
    'shell:openPath',
    'shell:openExternal',
    'dialog:showOpenDialog',
    'dialog:showSaveDialog',
    'dialog:showMessageBox',
    'shortcut:register',
    'shortcut:unregister',
    'shortcut:isRegistered',
    'screen:getAllDisplays',
    'screen:getPrimaryDisplay',
];

const validSendChannels = [
    'log',
    'systeminformation-call',
    'terminal_channel-3000',
    'terminal_channel-3002',
    'terminal_channel-3003',
    'terminal_channel-3004',
    'terminal_channel-3005',
    'ttyspawn',
    'getThemeOverride',
    'setThemeOverride',
    'getKbOverride',
    'setKbOverride'
];

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
    // App APIs
    app: {
        getVersion: () => ipcRenderer.invoke('app:getVersion'),
        getPath: (name) => ipcRenderer.invoke('app:getPath', name),
        quit: () => ipcRenderer.invoke('app:quit'),
        relaunch: () => ipcRenderer.invoke('app:relaunch'),
        focus: () => ipcRenderer.invoke('app:focus'),
        getCommandLineArgs: () => ipcRenderer.invoke('app:getCommandLineArgs'),
    },

    // Window APIs
    window: {
        minimize: () => ipcRenderer.invoke('window:minimize'),
        maximize: () => ipcRenderer.invoke('window:maximize'),
        setSize: (width, height) => ipcRenderer.invoke('window:setSize', width, height),
        getSize: () => ipcRenderer.invoke('window:getSize'),
        setFullScreen: (flag) => ipcRenderer.invoke('window:setFullScreen', flag),
        isFullScreen: () => ipcRenderer.invoke('window:isFullScreen'),
        toggleDevTools: () => ipcRenderer.invoke('window:toggleDevTools'),
        reload: () => ipcRenderer.invoke('window:reload'),
        onResize: (callback) => {
            const subscription = (event, ...args) => callback(...args);
            ipcRenderer.on('window:resize', subscription);
            return () => ipcRenderer.removeListener('window:resize', subscription);
        },
        onLeaveFullScreen: (callback) => {
            const subscription = (event, ...args) => callback(...args);
            ipcRenderer.on('window:leave-full-screen', subscription);
            return () => ipcRenderer.removeListener('window:leave-full-screen', subscription);
        },
    },

    // Clipboard APIs
    clipboard: {
        readText: () => ipcRenderer.invoke('clipboard:readText'),
        writeText: (text) => ipcRenderer.invoke('clipboard:writeText', text),
    },

    // Shell APIs
    shell: {
        openPath: (path) => ipcRenderer.invoke('shell:openPath', path),
        openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
    },

    // Dialog APIs
    dialog: {
        showOpenDialog: (options) => ipcRenderer.invoke('dialog:showOpenDialog', options),
        showSaveDialog: (options) => ipcRenderer.invoke('dialog:showSaveDialog', options),
        showMessageBox: (options) => ipcRenderer.invoke('dialog:showMessageBox', options),
    },

    // Screen APIs
    screen: {
        getAllDisplays: () => ipcRenderer.invoke('screen:getAllDisplays'),
        getPrimaryDisplay: () => ipcRenderer.invoke('screen:getPrimaryDisplay'),
    },

    // Global Shortcut APIs
    globalShortcut: {
        register: (accelerator, callback) => {
            const callbackId = `shortcut-callback-${Date.now()}-${Math.random()}`;
            ipcRenderer.on(callbackId, callback);
            return ipcRenderer.invoke('shortcut:register', accelerator, callbackId);
        },
        unregister: (accelerator) => ipcRenderer.invoke('shortcut:unregister', accelerator),
        isRegistered: (accelerator) => ipcRenderer.invoke('shortcut:isRegistered', accelerator),
    },

    // IPC Send (for existing channels)
    ipcSend: (channel, ...args) => {
        if (validSendChannels.includes(channel) || channel.startsWith('terminal_channel-')) {
            ipcRenderer.send(channel, ...args);
        }
    },

    // IPC Invoke
    ipcInvoke: (channel, ...args) => {
        if (validInvokeChannels.includes(channel)) {
            return ipcRenderer.invoke(channel, ...args);
        }
        return Promise.reject(new Error(`Invalid channel: ${channel}`));
    },

    // IPC On (for listening to events)
    ipcOn: (channel, callback) => {
        if (validSendChannels.includes(channel) ||
            channel.startsWith('systeminformation-reply-') ||
            channel.startsWith('terminal_channel-')) {
            const subscription = (event, ...args) => callback(event, ...args);
            ipcRenderer.on(channel, subscription);
            return () => ipcRenderer.removeListener(channel, subscription);
        }
        return () => {};
    },

    // IPC Remove Listener
    ipcRemoveListener: (channel, callback) => {
        ipcRenderer.removeListener(channel, callback);
    },

    // Process info
    process: {
        platform: process.platform,
        versions: {
            node: process.versions.node,
            chrome: process.versions.chrome,
            electron: process.versions.electron,
        },
        env: {
            TERM: process.env.TERM,
            PWD: process.env.PWD,
            USER: process.env.USER,
            USERNAME: process.env.USERNAME,
        }
    },

    // Utility functions
    util: {
        // Get username from home directory path or environment
        getUsername: () => {
            return os.userInfo().username || process.env.USER || process.env.USERNAME ||
                   os.homedir().split(path.sep).pop();
        }
    },

    // xterm and addons - exposed for terminal.class.js
    xterm: xtermModule ? {
        Terminal: xtermModule.Terminal,
    } : null,
    xtermAddonAttach: xtermAttach ? {
        AttachAddon: xtermAttach.AttachAddon,
    } : null,
    xtermAddonFit: xtermFit ? {
        FitAddon: xtermFit.FitAddon,
    } : null,
    xtermAddonLigatures: xtermLigatures ? {
        LigaturesAddon: xtermLigatures.LigaturesAddon,
    } : null,
    xtermAddonWebgl: xtermWebgl ? {
        WebglAddon: xtermWebgl.WebglAddon,
    } : null,
    color: colorModule,

    // GeoIP modules for netstat
    geolite2: geolite2,
    maxmind: maxmind,

    // Node.js modules (exposed for compatibility with existing code)
    // These are needed for classes that use require() directly
    nodeModules: {
        path: {
            join: path.join,
            resolve: path.resolve,
            dirname: path.dirname,
            basename: path.basename,
            extname: path.extname,
            sep: path.sep,
            delimiter: path.delimiter,
            normalize: path.normalize,
            isAbsolute: path.isAbsolute,
            parse: path.parse,
            format: path.format,
        },
        fs: {
            readFileSync: (path, options) => fs.readFileSync(path, options),
            writeFileSync: (path, data, options) => fs.writeFileSync(path, data, options),
            existsSync: (path) => fs.existsSync(path),
            readdirSync: (path, options) => fs.readdirSync(path, options),
            readdir: (path, options, callback) => {
                if (typeof options === 'function') {
                    callback = options;
                    options = undefined;
                }
                return fs.readdir(path, options, callback);
            },
            lstat: (path, callback) => fs.lstat(path, callback),
            lstatSync: (path) => fs.lstatSync(path),
            stat: (path, callback) => fs.stat(path, callback),
            statSync: (path) => fs.statSync(path),
            mkdirSync: (path, options) => fs.mkdirSync(path, options),
            readlink: (path, options, callback) => {
                if (typeof options === 'function') {
                    callback = options;
                    options = undefined;
                }
                return fs.readlink(path, options, callback);
            },
            watch: (path, options, listener) => fs.watch(path, options, listener),
            readFile: (path, options, callback) => {
                if (typeof options === 'function') {
                    callback = options;
                    options = undefined;
                }
                return fs.readFile(path, options, callback);
            },
            closeSync: (fd) => fs.closeSync(fd),
        },
        https: {
            get: (options, callback) => https.get(options, callback),
            request: (options, callback) => https.request(options, callback),
            Agent: https.Agent,
        },
        net: {
            Socket: net.Socket,
            connect: (options, connectListener) => net.connect(options, connectListener),
        },
        os: {
            type: os.type,
            cpus: os.cpus,
            hostname: os.hostname,
            homedir: os.homedir,
            platform: os.platform,
        },
        childProcess: {
            exec: (command, options, callback) => childProcess.exec(command, options, callback),
            spawn: (command, args, options) => childProcess.spawn(command, args, options),
        },
    },
});

// Also expose a way to require specific modules that are needed
contextBridge.exposeInMainWorld('requireModule', (moduleName) => {
    switch (moduleName) {
        case 'path':
            return {
                join: path.join,
                resolve: path.resolve,
                dirname: path.dirname,
                basename: path.basename,
                extname: path.extname,
                sep: path.sep,
                delimiter: path.delimiter,
                normalize: path.normalize,
                isAbsolute: path.isAbsolute,
                parse: path.parse,
                format: path.format,
            };
        case 'fs':
            return fs;
        case 'https':
            return https;
        case 'net':
            return net;
        case 'os':
            return {
                type: os.type,
                cpus: os.cpus,
                hostname: os.hostname,
                homedir: os.homedir,
                platform: os.platform,
            };
        case 'child_process':
            return {
                exec: childProcess.exec,
                spawn: childProcess.spawn,
            };
        case 'xterm':
            return xtermModule;
        case 'xterm-addon-attach':
            return xtermAttach;
        case 'xterm-addon-fit':
            return xtermFit;
        case 'xterm-addon-ligatures':
            return xtermLigatures;
        case 'xterm-addon-webgl':
            return xtermWebgl;
        case 'color':
            return colorModule;
        default:
            throw new Error(`Module '${moduleName}' is not available in preload context`);
    }
});

// Expose require for class files that use it directly
// This is needed for compatibility with existing class files
const createRequire = (moduleName) => {
    // Handle relative paths for local modules (like ./assets/...)
    if (moduleName.startsWith('./') || moduleName.startsWith('../')) {
        try {
            // Resolve the path relative to the src directory
            const modulePath = path.join(__dirname, moduleName);

            // Check if it's a JSON file
            if (moduleName.endsWith('.json')) {
                const content = fs.readFileSync(modulePath, 'utf-8');
                return JSON.parse(content);
            }

            // For JS files, read and return the content
            if (moduleName.endsWith('.js')) {
                const content = fs.readFileSync(modulePath, 'utf-8');
                // We can't execute it here, but some files might be data
                return content;
            }

            // Try as JSON if no extension
            try {
                const content = fs.readFileSync(modulePath + '.json', 'utf-8');
                return JSON.parse(content);
            } catch(e) {
                // Not a JSON file
            }

            return null;
        } catch (e) {
            console.error(`Failed to load local module: ${moduleName}`, e);
            return null;
        }
    }

    // For npm modules, use the same logic as requireModule
    switch (moduleName) {
        case 'path':
            return path;
        case 'fs':
            return fs;
        case 'https':
            return https;
        case 'net':
            return net;
        case 'os':
            return os;
        case 'child_process':
            return childProcess;
        case 'xterm':
            return xtermModule;
        case 'xterm-addon-attach':
            return xtermAttach;
        case 'xterm-addon-fit':
            return xtermFit;
        case 'xterm-addon-ligatures':
            return xtermLigatures;
        case 'xterm-addon-webgl':
            return xtermWebgl;
        case 'color':
            return colorModule;
        case 'howler':
            return require('howler');
        case 'systeminformation':
            return require('systeminformation');
        default:
            // Try to require it directly for other modules
            try {
                return require(moduleName);
            } catch (e) {
                console.error(`Cannot require module: ${moduleName}`, e);
                return null;
            }
    }
};

// Make require available globally for class files
contextBridge.exposeInMainWorld('require', createRequire);

// For debugging
console.log('Preload script loaded successfully');
