define([
	'dojo/lang',
	'dojo/Promise',
	'dojo/node!leadfoot/Server',
	'dojo/node!leadfoot/Command',
	'../ClientSuite',
	'../createProxy',
	'../EnvironmentType',
	'./Executor',
	'../ProxiedSession',
	'../Suite',
	'../util'
], function (
	lang,
	Promise,
	Server,
	Command,
	ClientSuite,
	createProxy,
	EnvironmentType,
	Executor,
	ProxiedSession,
	Suite,
	util
) {
	/**
	 * The Runner executor is used to run unit & functional tests in remote environments loaded through a WebDriver
	 * conduit.
	 *
	 * @constructor module:intern/lib/executors/Runner
	 * @extends module:intern/lib/executors/Executor
	 */
	function Runner() {
		Executor.apply(this, arguments);
		this._fixConfig();
	}

	var _super = Executor.prototype;
	Runner.prototype = lang.mixin(Object.create(_super), /** @lends module:intern/lib/executors/Runner# */ {
		constructor: Runner,

		config: {
			capabilities: {
				'idle-timeout': 60
			},
			maxConcurrency: Infinity,
			proxyPort: 9000,
			proxyUrl: 'http://localhost:9000/',
			reporters: [ 'runner' ],
			tunnel: 'NullTunnel',
			tunnelOptions: {
				tunnelId: '' + Date.now()
			}
		},

		mode: 'runner',

		/**
		 * Creates suites for each environment in which tests will be executed.
		 *
		 * @param {Configuration} config Intern configuration.
		 * @param {module:digdug/Tunnel} tunnel A Dig Dug tunnel.
		 * @param {Object} overrides Overrides to the user configuration provided via command-line.
		 * @returns {Suite[]} An array of root suites.
		 */
		_createSuites: function (config, tunnel, overrides) {
			return util.flattenEnvironments(config.capabilities, config.environments).map(function (environmentType) {
				var suite = new Suite({
					name: String(environmentType),
					publishAfterSetup: true,
					grep: config.grep,
					setup: function () {
						var server = new Server(tunnel.clientUrl, {
							proxy: tunnel.proxy
						});
						server.sessionConstructor = ProxiedSession;
						return server.createSession(environmentType).then(function (session) {
							session.coverageEnabled = true;
							session.proxyUrl = config.proxyUrl;
							session.proxyBasePathLength = config.basePath.length;

							var command = new Command(session);
							suite.remote = command;
							suite.environmentType = new EnvironmentType(session.capabilities);
						});
					},
					teardown: function () {
						var remote = this.remote;

						function endSession() {
							return tunnel.sendJobState(remote.session.sessionId, {
								success: suite.numFailedTests === 0 && !suite.error
							});
						}

						if (config.leaveRemoteOpen) {
							return endSession();
						}

						return remote.quit().finally(endSession);
					}
				});

				// The `suites` flag specified on the command-line as an empty string will just get converted to an
				// empty array in the client, which means we can skip the client tests entirely. Otherwise, if no
				// suites were specified on the command-line, we rely on the existence of `config.suites` to decide
				// whether or not to client suites. If `config.suites` is truthy, it may be an empty array on the
				// Node.js side but could be a populated array when it gets to the browser side (conditional based
				// on environment), so we require users to explicitly set it to a falsy value to assure the test
				// system that it should not run the client
				if (config.suites) {
					suite.tests.push(new ClientSuite({ parent: suite, config: config, args: overrides }));
				}

				return suite;
			});
		},

		/**
		 * Fixes up the configuration object with extra information specific to this executor.
		 */
		_fixConfig: function () {
			/* jshint node:true */
			var config = this.config;

			config.capabilities.name = config.config;

			var buildId = process.env.TRAVIS_COMMIT || process.env.BUILD_TAG;
			if (buildId) {
				config.capabilities.build = buildId;
			}

			config.proxyUrl = config.proxyUrl.replace(/\/*$/, '/');

			if (config.tunnel.indexOf('/') === -1) {
				config.tunnel = 'dojo/node!digdug/' + config.tunnel;
			}

			config.tunnelOptions.servers = (config.tunnelOptions.servers || []).concat(config.proxyUrl);
		},

		/**
		 * Loads a Dig Dug tunnel.
		 *
		 * @param {Configuration} config The Intern configuration object.
		 * @returns {module:digdug/Tunnel} A Dig Dug tunnel.
		 */
		_loadTunnel: function (config) {
			var reporterManager = this.reporterManager;

			return util.getModule(config.tunnel, function (Tunnel) {
				var tunnel = new Tunnel(config.tunnelOptions);

				tunnel.on('downloadprogress', function (progress) {
					reporterManager.emit('tunnelDownloadProgress', tunnel, progress);
				});
				tunnel.on('status', function (status) {
					reporterManager.emit('tunnelStatus', tunnel, status);
				});

				config.capabilities = lang.deepCopy(tunnel.extraCapabilities, config.capabilities);

				return tunnel;
			});
		},

		run: function () {
			var self = this;
			var config = this.config;
			var reporterManager = this.reporterManager;

			var proxy;
			var suites;
			var tunnel;

			var promise = _super.run.apply(this, arguments)
				.then(lang.bind(this, '_loadTunnel', config))
				.then(function (_tunnel) {
					tunnel = _tunnel;
					return self._createSuites(config, tunnel, self.global.getArguments());
				})
				.then(function (_suites) {
					suites = _suites;
					return self._loadTestModules(suites, config.functionalSuites);
				})
				.then(lang.bind(this, '_runProxy', config))
				.then(function (_proxy) {
					proxy = _proxy;
				});

			this.run = function () {
				return promise;
			};

			if (this.config.proxyOnly) {
				return promise;
			}

			promise = promise
				.then(function () {
					return reporterManager.emit('tunnelStart', tunnel).then(function () {
						return tunnel.start();
					});
				})
				.then(function () {
					return self._runTests(lang.bind(self, '_runSuites', suites, config.maxConcurrency));
				})
				.finally(function (error) {
					proxy.remove();
					return tunnel.close().then(function () {
						return reporterManager.emit('tunnelEnd', tunnel);
					}).then(function () {
						if (error instanceof Error) {
							throw error;
						}
					});
				});

			return promise;
		},

		/**
		 * Runs an instrumenting proxy for sending instrumented code to the remote environment and receiving data back
		 * from the remote environment.
		 *
		 * @param {Configuration} config The Intern configuration object.
		 * @returns {Handle} Remove handle.
		 */
		_runProxy: function (config) {
			// TODO: Fix `createProxy` to not run automatically.
			var proxy = createProxy({
				basePath: config.basePath,
				excludeInstrumentation: config.excludeInstrumentation,
				instrument: true,
				port: config.proxyPort,
				reporterManager: this.reporterManager
			});

			return {
				remove: function () {
					this.remove = function () {};
					proxy.close();
				}
			};
		},

		/**
		 * Runs each of the root suites, limited to a certain number of suites at the same time by `maxConcurrency`.
		 *
		 * @param {Suite[]} suites The root suites.
		 * @returns {Promise.<void>}
		 */
		_runSuites: function (suites, maxConcurrency) {
			var numSuitesCompleted = 0;
			var numSuitesToRun = suites.length;
			var queue = util.createQueue(maxConcurrency);

			return new Promise(function (resolve, reject) {
				suites.forEach(queue(function (suite) {
					return suite.run().then(function () {
						if (++numSuitesCompleted === numSuitesToRun) {
							resolve();
						}
					}, reject);
				}));
			});
		}
	});

	return Runner;
});