// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var assert = require('assert');
var fork = require('child_process').fork;
var net = require('net');
var EventEmitter = require('events').EventEmitter;
var util = require('util');

function isObject(o) {
  return (typeof o === 'object' && o !== null);
}

var debug;
if (process.env.NODE_DEBUG && /cluster/.test(process.env.NODE_DEBUG)) {
  debug = function(x) {
    var prefix = process.pid + ',' +
        (process.env.NODE_UNIQUE_ID ? 'Worker' : 'Master');
    console.error(prefix, x);
  };
} else {
  debug = function() { };
}

// cluster object:
function Cluster() {
  EventEmitter.call(this);
}

util.inherits(Cluster, EventEmitter);

var cluster = module.exports = new Cluster();

// Used in the master:
var masterStarted = false;
var ids = 0;
var serverHandlers = {};

// Used in the worker:
var serverListeners = {};
var queryIds = 0;
var queryCallbacks = {};

// Define isWorker and isMaster
cluster.isWorker = 'NODE_UNIQUE_ID' in process.env;
cluster.isMaster = ! cluster.isWorker;

// The worker object is only used in a worker
cluster.worker = cluster.isWorker ? {} : null;
// The workers array is only used in the master
cluster.workers = cluster.isMaster ? {} : null;

// Settings object
var settings = cluster.settings = {};

// Simple function to call a function on each worker
function eachWorker(cb) {
  // Go through all workers
  for (var id in cluster.workers) {
    if (cluster.workers.hasOwnProperty(id)) {
      cb(cluster.workers[id]);
    }
  }
}

// Extremely simple progress tracker
function ProgressTracker(missing, callback) {
  this.missing = missing;
  this.callback = callback;
}
ProgressTracker.prototype.done = function() {
  this.missing -= 1;
  this.check();
};
ProgressTracker.prototype.check = function() {
  if (this.missing === 0) this.callback();
};

cluster.setupMaster = function(options) {
  // This can only be called from the master.
  assert(cluster.isMaster);

  // Don't allow this function to run more than once
  if (masterStarted) return;
  masterStarted = true;

  // Get filename and arguments
  options = options || {};

  // Set settings object
  settings = cluster.settings = {
    exec: options.exec || process.argv[1],
    execArgv: options.execArgv || process.execArgv,
    args: options.args || process.argv.slice(2),
    silent: options.silent || false
  };

  // emit setup event
  cluster.emit('setup');
};

// Check if a message is internal only
var INTERNAL_PREFIX = 'NODE_CLUSTER_';
function isInternalMessage(message) {
  return (isObject(message) &&
          typeof message.cmd === 'string' &&
          message.cmd.indexOf(INTERNAL_PREFIX) === 0);
}

// Modify message object to be internal
function internalMessage(inMessage) {
  var outMessage = util._extend({}, inMessage);

  // Add internal prefix to cmd
  outMessage.cmd = INTERNAL_PREFIX + (outMessage.cmd || '');

  return outMessage;
}

// Handle callback messages
function handleResponse(outMessage, outHandle, inMessage, inHandle, worker) {

  // The message there will be sent
  var message = internalMessage(outMessage);

  // callback id - will be undefined if not set
  message._queryEcho = inMessage._requestEcho;

  // Call callback if a query echo is received
  if (inMessage._queryEcho) {
    queryCallbacks[inMessage._queryEcho](inMessage.content, inHandle);
    delete queryCallbacks[inMessage._queryEcho];
  }

  // Send if outWrap contains something useful
  if (!(outMessage === undefined && message._queryEcho === undefined)) {
    sendInternalMessage(worker, message, outHandle);
  }
}

// Handle messages from both master and workers
var messageHandler = {};
function handleMessage(worker, inMessage, inHandle) {
  if (!isInternalMessage(inMessage)) return;

  // Remove internal prefix
  var message = util._extend({}, inMessage);
  message.cmd = inMessage.cmd.substr(INTERNAL_PREFIX.length);

  function respond(outMessage, outHandler) {
    handleResponse(outMessage, outHandler, inMessage, inHandle, worker);
  }

  // Run handler if it exists
  if (messageHandler[message.cmd]) {
    messageHandler[message.cmd](message, worker, respond);
  } else {
    respond();
  }
}

// Messages to the master will be handled using these methods
if (cluster.isMaster) {

  // Handle online messages from workers
  messageHandler.online = function(message, worker, send) {
    worker.state = 'online';
    debug('Worker ' + worker.process.pid + ' online');
    worker.emit('online');
    cluster.emit('online', worker);

    send();
  };

  // Handle queryServer messages from workers
  messageHandler.queryServer = function(message, worker, send) {

    // This sequence of information is unique to the connection
    // but not to the worker
    var args = message.args;
    var key = JSON.stringify(args);

    if (serverHandlers.hasOwnProperty(key)) {
      send({}, serverHandlers[key]);
      return;
    }

    var server = serverHandlers[key] = net.Server();
    server.once('listening', function() {
      send({}, server);
    });
    server.listen.apply(server, args);
  };

  // Handle listening messages from workers
  messageHandler.listening = function(message, worker, send) {

    worker.state = 'listening';

    // Emit listening, now that we know the worker is listening
    worker.emit('listening', message.address);
    cluster.emit('listening', worker, message.address);

    send();
  };

  // Handle suicide messages from workers
  messageHandler.suicide = function(message, worker, send) {
    worker.suicide = true;

    send();
  };

}

// Messages to a worker will be handled using these methods
else if (cluster.isWorker) {

  // Handle worker.disconnect from master
  messageHandler.disconnect = function(message, worker, send) {
    worker.disconnect();
    send();
  };
}

function toDecInt(value) {
  value = parseInt(value, 10);
  return isNaN(value) ? null : value;
}

// Create a worker object, that works both for master and worker
function Worker(customEnv) {
  if (!(this instanceof Worker)) return new Worker();
  EventEmitter.call(this);

  var self = this;
  var env = process.env;

  // Assign a unique id, default null
  this.id = cluster.isMaster ? ++ids : toDecInt(env.NODE_UNIQUE_ID);

  // XXX: Legacy.  Remove in 0.9
  this.workerID = this.uniqueID = this.id;

  // Assign state
  this.state = 'none';

  // Create or get process
  if (cluster.isMaster) {

    // Create env object
    // first: copy and add id property
    var envCopy = util._extend({}, env);
    envCopy['NODE_UNIQUE_ID'] = this.id;
    // second: extend envCopy with the env argument
    if (isObject(customEnv)) {
      envCopy = util._extend(envCopy, customEnv);
    }

    // fork worker
    this.process = fork(settings.exec, settings.args, {
      'env': envCopy,
      'silent': settings.silent,
      'execArgv': settings.execArgv
    });
  } else {
    this.process = process;
  }

  if (cluster.isMaster) {
    // Save worker in the cluster.workers array
    cluster.workers[this.id] = this;

    // Emit a fork event, on next tick
    // There is no worker.fork event since this has no real purpose
    process.nextTick(function() {
      cluster.emit('fork', self);
    });
  }

  // handle internalMessage, exit and disconnect event
  this.process.on('internalMessage', handleMessage.bind(null, this));
  this.process.once('exit', function(exitCode, signalCode) {
    prepareExit(self, 'dead');
    self.emit('exit', exitCode, signalCode);
    cluster.emit('exit', self, exitCode, signalCode);
  });
  this.process.once('disconnect', function() {
    prepareExit(self, 'disconnected');
    self.emit('disconnect');
    cluster.emit('disconnect', self);
  });

  // relay message and error
  this.process.on('message', this.emit.bind(this, 'message'));
  this.process.on('error', this.emit.bind(this, 'error'));

}
util.inherits(Worker, EventEmitter);
cluster.Worker = Worker;

function prepareExit(worker, state) {

  // set state to disconnect
  worker.state = state;

  // Make suicide a boolean
  worker.suicide = !!worker.suicide;

  // Remove from workers in the master
  if (cluster.isMaster) {
    delete cluster.workers[worker.id];
  }
}

// Send internal message
function sendInternalMessage(worker, message/*, handler, callback*/) {

  // Exist callback
  var callback = arguments[arguments.length - 1];
  if (typeof callback !== 'function') {
    callback = undefined;
  }

  // exist handler
  var handler = arguments[2] !== callback ? arguments[2] : undefined;

  if (!isInternalMessage(message)) {
    message = internalMessage(message);
  }

  // Store callback for later
  if (callback) {
    message._requestEcho = worker.id + ':' + (++queryIds);
    queryCallbacks[message._requestEcho] = callback;
  }


  worker.send(message, handler);
}

// Send message to worker or master
Worker.prototype.send = function() {

  // You could also just use process.send in a worker
  this.process.send.apply(this.process, arguments);
};

// Kill the worker without restarting
Worker.prototype.destroy = function() {
  var self = this;

  this.suicide = true;

  if (cluster.isMaster) {
    // Disconnect IPC channel
    // this way the worker won't need to propagate suicide state to master
    if (self.process.connected) {
      self.process.once('disconnect', function() {
        self.process.kill();
      });
      self.process.disconnect();
    } else {
      self.process.kill();
    }

  } else {
    // Channel is open
    if (this.process.connected) {

      // Inform master to suicide and then kill
      sendInternalMessage(this, {cmd: 'suicide'}, function() {
        process.exit(0);
      });

      // When channel is closed, terminate the process
      this.process.once('disconnect', function() {
        process.exit(0);
      });
    } else {
      process.exit(0);
    }
  }
};

// The .disconnect function will close all servers
// and then disconnect the IPC channel.
if (cluster.isMaster) {
  // Used in master
  Worker.prototype.disconnect = function() {
    this.suicide = true;

    sendInternalMessage(this, {cmd: 'disconnect'});
  };

} else {
  // Used in workers
  Worker.prototype.disconnect = function() {
    var self = this;

    this.suicide = true;

    // keep track of open servers
    var servers = Object.keys(serverListeners).length;
    var progress = new ProgressTracker(servers, function() {
      // There are no more servers open so we will close the IPC channel.
      // Closing the IPC channel will emit a disconnect event
      // in both master and worker on the process object.
      // This event will be handled by prepareExit.
      self.process.disconnect();
    });

    // depending on where this function was called from (master or worker)
    // The suicide state has already been set,
    // but it doesn't really matter if we set it again.
    sendInternalMessage(this, {cmd: 'suicide'}, function() {
      // in case there are no servers
      progress.check();

      // closing all servers gracefully
      var server;
      for (var key in serverListeners) {
        server = serverListeners[key];

        // in case the server is closed we won't close it again
        if (server._handle === null) {
          progress.done();
          continue;
        }

        server.on('close', progress.done.bind(progress));
        server.close();
      }
    });

  };
}

// Fork a new worker
cluster.fork = function(env) {
  // This can only be called from the master.
  assert(cluster.isMaster);

  // Make sure that the master has been initialized
  cluster.setupMaster();

  return (new cluster.Worker(env));
};

// execute .disconnect on all workers and close handlers when done
cluster.disconnect = function(callback) {
  // This can only be called from the master.
  assert(cluster.isMaster);

  // Close all TCP handlers when all workers are disconnected
  var workers = Object.keys(cluster.workers).length;
  var progress = new ProgressTracker(workers, function() {
    for (var key in serverHandlers) {
      serverHandlers[key].close();
      delete serverHandlers[key];
    }

    // call callback when done
    if (callback) callback();
  });

  // begin disconnecting all workers
  eachWorker(function(worker) {
    worker.once('disconnect', progress.done.bind(progress));
    worker.disconnect();
  });

  // in case there weren't any workers
  progress.check();
};

// Internal function. Called from src/node.js when worker process starts.
cluster._setupWorker = function() {

  // Get worker class
  var worker = cluster.worker = new Worker();

  // we will terminate the worker
  // when the worker is disconnected from the parent accidentally
  process.once('disconnect', function() {
    if (worker.suicide !== true) {
      process.exit(0);
    }
  });

  // Tell master that the worker is online
  worker.state = 'online';
  sendInternalMessage(worker, { cmd: 'online' });
};

// Internal function. Called by lib/net.js when attempting to bind a server.
if (cluster.isWorker) {
  var localListen = net.Server.prototype.listen;
  net.Server.prototype.listen = function() {
    var self = this;

    var args = new Array(arguments.length);
    for (var i = 0; i < arguments.length; i++) {
      args[i] = arguments[i];
    }

    // filter out callback
    if (typeof args[args.length - 1] === 'function') {
      this.once('listening', args.pop());
    }

    // add server (used by. dissconnect)
    serverListeners[JSON.stringify(args)] = this;

    // send callback to master, telling that worker is listening
    this.once('listening', function() {
      cluster.worker.state = 'listening';

      var message = { cmd: 'listening', address: this.address() };
      sendInternalMessage(cluster.worker, message);
    });

    // request server
    var message = { cmd: 'queryServer', args: args };

    sendInternalMessage(cluster.worker, message, function(msg, server) {
      localListen.call(self, server);
    });
  };
}
