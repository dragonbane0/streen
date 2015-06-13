'use strict';

var log       = require('./lib/log');
var config    = require('hi-config'); config.load('config.json');
var format    = require('util').format;
var rpc       = require('axon-rpc');
var axon      = require('axon');
var rep       = axon.socket('rep');
var pubSock   = axon.socket('pub');
var rpcServer = new rpc.Server(rep);

var socketsBound      = false;
var heartbeatTimeouts = {};
var PUB_PORT          = config.get('pubPort') || 9455;
var RPC_PORT          = config.get('rpcPort') || 9456;
var HEARTBEAT_TIMEOUT = 15 * 1000;

module.exports = {
    pubSock: pubSock,
    rpcServer: rpcServer
};

// Wait until we've defined module.exports before loading the Twitch IRC and Slack libs
var ircClient = require('./lib/twitch_irc');
var slack     = require('./lib/slack');

//var db     = require('twitch-irc-db')({database: './data'});
//var api    = require('twitch-irc-api');

// twitch-irc can be leaky. This enables a sysadmin to pass '--expose-gc' and force a full GC cycle every 15 minutes.
if (global.gc) {
    log.info('Running manual garbage collection every 15 minutes');
    setInterval(function () {
        global.gc();
    }, 15 * 60 * 1000);
}

// Oh no
process.on('unhandledException', function (err) {
    log.error(err.stack);
    slack.status(format('I\'ve encountered an unhandled error, and will now exit:```%s```', err.stack));
    pubSock.send('crash', err);
    setTimeout(function () {
        process.exit(1);
    }, 1000);
});

process.on('SIGINT', function () {
    log.info('Exiting from SIGINT in one second');
    slack.status('I\'m exiting from a deliberate SIGINT. This was probably intentional.');
    setTimeout(function () {
        process.exit(0);
    }, 1000);
});

ircClient
    .addListener('connected', function () {
        if (socketsBound) {
            pubSock.send('connected');
        } else {
            bindSockets();
        }
    });

function bindSockets() {
    pubSock.bind(PUB_PORT);
    rep.bind(RPC_PORT);
    pubSock.send('connected');

    socketsBound = true;

    // Streen does not join any channels on its own.
    // It waits for a Siphon to request that it join an array of channels.
    rpcServer.expose('join', function (channel, fn) {
        resetHeartbeat(channel);
        if (ircClient.currentChannels.indexOf(channel) >= 0) {
            // Already in channel, invoke callback with the name
            fn(null, channel);
        } else {
            ircClient.join('#' + channel);
            fn(null, null);
        }
    });

    rpcServer.expose('timeout', function (channel, username, seconds, fn) {
        ircClient.timeout(channel, username, seconds).then(function() {
            fn(null, null);
        });
    });

    rpcServer.expose('heartbeat', function (channels, fn) {
        channels.forEach(resetHeartbeat);
        fn(null, HEARTBEAT_TIMEOUT);
    });
}

// Siphons must send a heartbeat every HEARTBEAT_TIMEOUT seconds.
// Otherwise, their channels are parted.
// A siphon can miss no more than one consecutive heartbeat.
function resetHeartbeat(channel, fn) {
    fn = fn || function () {};
    clearTimeout(heartbeatTimeouts[channel]);
    heartbeatTimeouts[channel] = setTimeout(function () {
        ircClient.part('#' + channel).then(function () {
            clearTimeout(heartbeatTimeouts[channel]);
            delete heartbeatTimeouts[channel];
            fn(null, channel);
        });
    }, HEARTBEAT_TIMEOUT * 2 + 1000);
}