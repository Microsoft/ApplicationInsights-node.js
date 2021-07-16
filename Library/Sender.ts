import fs = require("fs");
import http = require("http");
import os = require("os");
import path = require("path");
import zlib = require("zlib");
import child_process = require("child_process");

import Logging = require("./Logging");
import Config = require("./Config")
import Contracts = require("../Declarations/Contracts");
import AutoCollectHttpDependencies = require("../AutoCollection/HttpDependencies");
import Util = require("./Util");
import { Statsbeat } from "../AutoCollection/Statsbeat";
import { StatsbeatFeature } from "../Declarations/Constants";

class Sender {
    private static TAG = "Sender";
    private static ICACLS_PATH = `${process.env.systemdrive}/windows/system32/icacls.exe`;
    private static POWERSHELL_PATH = `${process.env.systemdrive}/windows/system32/windowspowershell/v1.0/powershell.exe`;
    private static ACLED_DIRECTORIES: { [id: string]: boolean } = {};
    private static ACL_IDENTITY: string = null;

    // the amount of time the SDK will wait between resending cached data, this buffer is to avoid any throttling from the service side
    public static WAIT_BETWEEN_RESEND = 60 * 1000; // 1 minute
    public static MAX_BYTES_ON_DISK = 50 * 1024 * 1024; // 50 mb
    public static MAX_CONNECTION_FAILURES_BEFORE_WARN = 5;
    public static CLEANUP_TIMEOUT = 60 * 60 * 1000; // 1 hour
    public static FILE_RETEMPTION_PERIOD = 7 * 24 * 60 * 60 * 1000; // 7 days
    public static TEMPDIR_PREFIX: string = "appInsights-node";
    public static OS_PROVIDES_FILE_PROTECTION = false;
    public static USE_ICACLS = os.type() === "Windows_NT";

    private _config: Config;
    private _statsbeat: Statsbeat;
    private _onSuccess: (response: string) => void;
    private _onError: (error: Error) => void;
    private _enableDiskRetryMode: boolean;
    private _numConsecutiveFailures: number;
    private _numConsecutiveRedirects: number;
    private _resendTimer: NodeJS.Timer | null;
    private _fileCleanupTimer: NodeJS.Timer;
    private _redirectedHost: string = null;
    private _tempDir: string;
    protected _resendInterval: number;
    protected _maxBytesOnDisk: number;

    constructor(config: Config, onSuccess?: (response: string) => void, onError?: (error: Error) => void, statsbeat?: Statsbeat) {
        this._config = config;
        this._onSuccess = onSuccess;
        this._onError = onError;
        this._statsbeat = statsbeat;
        this._enableDiskRetryMode = false;
        this._resendInterval = Sender.WAIT_BETWEEN_RESEND;
        this._maxBytesOnDisk = Sender.MAX_BYTES_ON_DISK;
        this._numConsecutiveFailures = 0;
        this._numConsecutiveRedirects = 0;
        this._resendTimer = null;
        this._fileCleanupTimer = null;
        // tmpdir is /tmp for *nix and USERDIR/AppData/Local/Temp for Windows
        this._tempDir = path.join(os.tmpdir(), Sender.TEMPDIR_PREFIX + this._config.instrumentationKey);

        if (!Sender.OS_PROVIDES_FILE_PROTECTION) {
            // Node's chmod levels do not appropriately restrict file access on Windows
            // Use the built-in command line tool ICACLS on Windows to properly restrict
            // access to the temporary directory used for disk retry mode.
            if (Sender.USE_ICACLS) {
                // This should be async - but it's currently safer to have this synchronous
                // This guarantees we can immediately fail setDiskRetryMode if we need to
                try {
                    Sender.OS_PROVIDES_FILE_PROTECTION = fs.existsSync(Sender.ICACLS_PATH);
                } catch (e) { }
                if (!Sender.OS_PROVIDES_FILE_PROTECTION) {
                    Logging.warn(Sender.TAG, "Could not find ICACLS in expected location! This is necessary to use disk retry mode on Windows.")
                }
            } else {
                // chmod works everywhere else
                Sender.OS_PROVIDES_FILE_PROTECTION = true;
            }
        }
    }

    /**
    * Enable or disable offline mode
    */
    public setDiskRetryMode(value: boolean, resendInterval?: number, maxBytesOnDisk?: number) {
        this._enableDiskRetryMode = Sender.OS_PROVIDES_FILE_PROTECTION && value;
        if (typeof resendInterval === 'number' && resendInterval >= 0) {
            this._resendInterval = Math.floor(resendInterval);
        }
        if (typeof maxBytesOnDisk === 'number' && maxBytesOnDisk >= 0) {
            this._maxBytesOnDisk = Math.floor(maxBytesOnDisk);
        }

        if (value && !Sender.OS_PROVIDES_FILE_PROTECTION) {
            this._enableDiskRetryMode = false;
            Logging.warn(Sender.TAG, "Ignoring request to enable disk retry mode. Sufficient file protection capabilities were not detected.")
        }
        if (this._enableDiskRetryMode) {
            if (this._statsbeat) {
                this._statsbeat.addFeature(StatsbeatFeature.DISK_RETRY);
            }
            // Starts file cleanup task
            if (!this._fileCleanupTimer) {
                this._fileCleanupTimer = setTimeout(() => { this._fileCleanupTask(); }, Sender.CLEANUP_TIMEOUT);
                this._fileCleanupTimer.unref();
            }
        }
        else {
            if (this._statsbeat) {
                this._statsbeat.removeFeature(StatsbeatFeature.DISK_RETRY);
            }
            if (this._fileCleanupTimer) {
                clearTimeout(this._fileCleanupTimer);
            }
        }
    }

    public async send(envelopes: Contracts.EnvelopeTelemetry[], callback?: (v: string) => void) {
        if (envelopes) {
            var endpointUrl = this._redirectedHost || this._config.endpointUrl;

            // todo: investigate specifying an agent here: https://nodejs.org/api/http.html#http_class_http_agent
            var options = {
                method: "POST",
                withCredentials: false,
                headers: <{ [key: string]: string }>{
                    "Content-Type": "application/x-json-stream"
                }
            };

            let batch: string = "";
            envelopes.forEach(envelope => {
                var payload: string = this._stringify(envelope);
                if (typeof payload !== "string") {
                    return;
                }
                batch += payload + "\n";
            });
            // Remove last \n
            if (batch.length > 0) {
                batch = batch.substring(0, batch.length - 1);
            }

            let payload: Buffer = Buffer.from ? Buffer.from(batch) : new Buffer(batch);

            zlib.gzip(payload, (err, buffer) => {
                var dataToSend = buffer;
                if (err) {
                    Logging.warn(err);
                    dataToSend = payload; // something went wrong so send without gzip
                    options.headers["Content-Length"] = payload.length.toString();
                } else {
                    options.headers["Content-Encoding"] = "gzip";
                    options.headers["Content-Length"] = buffer.length.toString();
                }

                Logging.info(Sender.TAG, options);

                // Ensure this request is not captured by auto-collection.
                (<any>options)[AutoCollectHttpDependencies.disableCollectionRequestOption] = true;

                let startTime = +new Date();

                var requestCallback = (res: http.ClientResponse) => {
                    res.setEncoding("utf-8");

                    //returns empty if the data is accepted
                    var responseString = "";
                    res.on("data", (data: string) => {
                        responseString += data;
                    });

                    res.on("end", () => {
                        let endTime = +new Date();
                        let duration = endTime - startTime;
                        this._numConsecutiveFailures = 0;
                        if (this._enableDiskRetryMode) {
                            // try to send any cached events if the user is back online
                            if (res.statusCode === 200) {
                                if (!this._resendTimer) {
                                    this._resendTimer = setTimeout(() => {
                                        this._resendTimer = null;
                                        this._sendFirstFileOnDisk()
                                    }, this._resendInterval);
                                    this._resendTimer.unref();
                                }
                            } else if (this._isRetriable(res.statusCode)) {
                                try {
                                    if (this._statsbeat) {
                                        this._statsbeat.countRetry();
                                        if (res.statusCode === 429) {
                                            this._statsbeat.countThrottle();
                                        }
                                    }
                                    const breezeResponse = JSON.parse(responseString) as Contracts.BreezeResponse;
                                    let filteredEnvelopes: Contracts.EnvelopeTelemetry[] = [];
                                    breezeResponse.errors.forEach(error => {
                                        if (this._isRetriable(error.statusCode)) {
                                            filteredEnvelopes.push(envelopes[error.index]);
                                        }
                                    });
                                    if (filteredEnvelopes.length > 0) {
                                        this._storeToDisk(filteredEnvelopes);
                                    }
                                }
                                catch (ex) {
                                    this._storeToDisk(envelopes); // Retriable status code with not valid Breeze response
                                }
                            }
                        }
                        // Redirect handling
                        if (res.statusCode === 307 || // Temporary Redirect
                            res.statusCode === 308) { // Permanent Redirect
                            this._numConsecutiveRedirects++;
                            // To prevent circular redirects
                            if (this._numConsecutiveRedirects < 10) {
                                // Try to get redirect header
                                const locationHeader = res.headers["location"] ? res.headers["location"].toString() : null;
                                if (locationHeader) {
                                    this._redirectedHost = locationHeader;
                                    // Send to redirect endpoint as HTTPs library doesn't handle redirect automatically
                                    this.send(envelopes, callback);
                                }
                            }
                            else {
                                if (this._statsbeat) {
                                    this._statsbeat.countException();
                                }
                                if (typeof callback === "function") {
                                    callback("Error sending telemetry because of circular redirects.");
                                }
                            }

                        }
                        else {
                            if (this._statsbeat) {
                                this._statsbeat.countRequest(duration, res.statusCode === 200);
                            }
                            this._numConsecutiveRedirects = 0;
                            if (typeof callback === "function") {
                                callback(responseString);
                            }
                            Logging.info(Sender.TAG, responseString);
                            if (typeof this._onSuccess === "function") {
                                this._onSuccess(responseString);
                            }
                        }
                    });
                };

                var req = Util.makeRequest(this._config, endpointUrl, options, requestCallback);

                req.on("error", (error: Error) => {
                    // todo: handle error codes better (group to recoverable/non-recoverable and persist)
                    this._numConsecutiveFailures++;
                    if (this._statsbeat) {
                        this._statsbeat.countException();
                    }

                    // Only use warn level if retries are disabled or we've had some number of consecutive failures sending data
                    // This is because warn level is printed in the console by default, and we don't want to be noisy for transient and self-recovering errors
                    // Continue informing on each failure if verbose logging is being used
                    if (!this._enableDiskRetryMode || this._numConsecutiveFailures > 0 && this._numConsecutiveFailures % Sender.MAX_CONNECTION_FAILURES_BEFORE_WARN === 0) {
                        let notice = "Ingestion endpoint could not be reached. This batch of telemetry items has been lost. Use Disk Retry Caching to enable resending of failed telemetry. Error:";
                        if (this._enableDiskRetryMode) {
                            notice = `Ingestion endpoint could not be reached ${this._numConsecutiveFailures} consecutive times. There may be resulting telemetry loss. Most recent error:`;
                        }
                        Logging.warn(Sender.TAG, notice, Util.dumpObj(error));
                    } else {
                        let notice = "Transient failure to reach ingestion endpoint. This batch of telemetry items will be retried. Error:";
                        Logging.info(Sender.TAG, notice, Util.dumpObj(error))
                    }
                    this._onErrorHelper(error);

                    if (typeof callback === "function") {
                        if (error) {
                            callback(Util.dumpObj(error));
                        }
                        callback("Error sending telemetry");
                    }

                    if (this._enableDiskRetryMode) {
                        this._storeToDisk(envelopes);
                    }
                });

                req.write(dataToSend);
                req.end();
            });
        }
    }

    public saveOnCrash(envelopes: Contracts.EnvelopeTelemetry[]) {
        if (this._enableDiskRetryMode) {
            this._storeToDiskSync(this._stringify(envelopes));
        }
    }

    private _isRetriable(statusCode: number) {
        return (
            statusCode === 206 || // Retriable
            statusCode === 408 || // Timeout
            statusCode === 429 || // Throttle
            statusCode === 439 || // Quota
            statusCode === 500 || // Server Error
            statusCode === 503 // Server Unavilable
        );
    }

    private _runICACLS(args: string[], callback: (err: Error) => void) {
        var aclProc = child_process.spawn(Sender.ICACLS_PATH, args, <any>{ windowsHide: true });
        aclProc.on("error", (e: Error) => callback(e));
        aclProc.on("close", (code: number, signal: string) => {
            return callback(code === 0 ? null : new Error(`Setting ACL restrictions did not succeed (ICACLS returned code ${code})`));
        });
    }

    private _runICACLSSync(args: string[]) {
        // Some very old versions of Node (< 0.11) don't have this
        if (child_process.spawnSync) {
            var aclProc = child_process.spawnSync(Sender.ICACLS_PATH, args, <any>{ windowsHide: true });
            if (aclProc.error) {
                throw aclProc.error;
            } else if (aclProc.status !== 0) {
                throw new Error(`Setting ACL restrictions did not succeed (ICACLS returned code ${aclProc.status})`);
            }
        } else {
            throw new Error("Could not synchronously call ICACLS under current version of Node.js");
        }
    }

    private _getACLIdentity(callback: (error: Error, identity: string) => void) {
        if (Sender.ACL_IDENTITY) {
            return callback(null, Sender.ACL_IDENTITY);
        }
        var psProc = child_process.spawn(Sender.POWERSHELL_PATH,
            ["-Command", "[System.Security.Principal.WindowsIdentity]::GetCurrent().Name"], <any>{
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'] // Needed to prevent hanging on Win 7
            });
        let data = "";
        psProc.stdout.on("data", (d: string) => data += d);
        psProc.on("error", (e: Error) => callback(e, null));
        psProc.on("close", (code: number, signal: string) => {
            Sender.ACL_IDENTITY = data && data.trim();
            return callback(
                code === 0 ? null : new Error(`Getting ACL identity did not succeed (PS returned code ${code})`),
                Sender.ACL_IDENTITY);
        });
    }

    private _getACLIdentitySync() {
        if (Sender.ACL_IDENTITY) {
            return Sender.ACL_IDENTITY;
        }
        // Some very old versions of Node (< 0.11) don't have this
        if (child_process.spawnSync) {
            var psProc = child_process.spawnSync(Sender.POWERSHELL_PATH,
                ["-Command", "[System.Security.Principal.WindowsIdentity]::GetCurrent().Name"], <any>{
                    windowsHide: true,
                    stdio: ['ignore', 'pipe', 'pipe'] // Needed to prevent hanging on Win 7
                });
            if (psProc.error) {
                throw psProc.error;
            } else if (psProc.status !== 0) {
                throw new Error(`Getting ACL identity did not succeed (PS returned code ${psProc.status})`);
            }
            Sender.ACL_IDENTITY = psProc.stdout && psProc.stdout.toString().trim();
            return Sender.ACL_IDENTITY;
        } else {
            throw new Error("Could not synchronously get ACL identity under current version of Node.js");
        }
    }

    private _getACLArguments(directory: string, identity: string) {
        return [directory,
            "/grant", "*S-1-5-32-544:(OI)(CI)F", // Full permission for Administrators
            "/grant", `${identity}:(OI)(CI)F`, // Full permission for current user
            "/inheritance:r"]; // Remove all inherited permissions
    }

    private _applyACLRules(directory: string, callback: (err: Error) => void) {
        if (!Sender.USE_ICACLS) {
            return callback(null);
        }

        // For performance, only run ACL rules if we haven't already during this session
        if (Sender.ACLED_DIRECTORIES[directory] === undefined) {
            // Avoid multiple calls race condition by setting ACLED_DIRECTORIES to false for this directory immediately
            // If batches are being failed faster than the processes spawned below return, some data won't be stored to disk
            // This is better than the alternative of potentially infinitely spawned processes
            Sender.ACLED_DIRECTORIES[directory] = false;

            // Restrict this directory to only current user and administrator access
            this._getACLIdentity((err, identity) => {
                if (err) {
                    Sender.ACLED_DIRECTORIES[directory] = false; // false is used to cache failed (vs undefined which is "not yet tried")
                    return callback(err);
                } else {
                    this._runICACLS(this._getACLArguments(directory, identity), (err) => {
                        Sender.ACLED_DIRECTORIES[directory] = !err;
                        return callback(err);
                    });
                }
            });
        } else {
            return callback(Sender.ACLED_DIRECTORIES[directory] ? null :
                new Error("Setting ACL restrictions did not succeed (cached result)"));
        }
    }

    private _applyACLRulesSync(directory: string) {
        if (Sender.USE_ICACLS) {
            // For performance, only run ACL rules if we haven't already during this session
            if (Sender.ACLED_DIRECTORIES[directory] === undefined) {
                this._runICACLSSync(this._getACLArguments(directory, this._getACLIdentitySync()));
                Sender.ACLED_DIRECTORIES[directory] = true; // If we get here, it succeeded. _runIACLSSync will throw on failures
                return;
            } else if (!Sender.ACLED_DIRECTORIES[directory]) { // falsy but not undefined
                throw new Error("Setting ACL restrictions did not succeed (cached result)");
            }
        }
    }

    private _confirmDirExists(directory: string, callback: (err: NodeJS.ErrnoException) => void): void {
        fs.lstat(directory, (err, stats) => {
            if (err && err.code === 'ENOENT') {
                fs.mkdir(directory, (err) => {
                    if (err && err.code !== 'EEXIST') { // Handle race condition by ignoring EEXIST
                        callback(err);
                    } else {
                        this._applyACLRules(directory, callback);
                    }
                });
            } else if (!err && stats.isDirectory()) {
                this._applyACLRules(directory, callback);
            } else {
                callback(err || new Error("Path existed but was not a directory"));
            }
        });
    }

    /**
     * Computes the size (in bytes) of all files in a directory at the root level. Asynchronously.
     */
    private _getShallowDirectorySize(directory: string, callback: (err: NodeJS.ErrnoException, size: number) => void) {
        // Get the directory listing
        fs.readdir(directory, (err, files) => {
            if (err) {
                return callback(err, -1);
            }

            let error: NodeJS.ErrnoException = null;
            let totalSize = 0;
            let count = 0;

            if (files.length === 0) {
                callback(null, 0);
                return;
            }

            // Query all file sizes
            for (let i = 0; i < files.length; i++) {
                fs.stat(path.join(directory, files[i]), (err, fileStats) => {
                    count++;

                    if (err) {
                        error = err;
                    } else {
                        if (fileStats.isFile()) {
                            totalSize += fileStats.size;
                        }
                    }

                    if (count === files.length) {
                        // Did we get an error?
                        if (error) {
                            callback(error, -1);
                        } else {
                            callback(error, totalSize);
                        }
                    }
                });
            }
        });
    }

    /**
     * Computes the size (in bytes) of all files in a directory at the root level. Synchronously.
     */
    private _getShallowDirectorySizeSync(directory: string): number {
        let files = fs.readdirSync(directory);
        let totalSize = 0;
        for (let i = 0; i < files.length; i++) {
            totalSize += fs.statSync(path.join(directory, files[i])).size;
        }
        return totalSize;
    }

    /**
     * Stores the payload as a json file on disk in the temp directory
     */
    private _storeToDisk(envelopes: Contracts.EnvelopeTelemetry[]) {
        // This will create the dir if it does not exist
        // Default permissions on *nix are directory listing from other users but no file creations
        Logging.info(Sender.TAG, "Checking existence of data storage directory: " + this._tempDir);
        this._confirmDirExists(this._tempDir, (error) => {
            if (error) {
                Logging.warn(Sender.TAG, "Error while checking/creating directory: " + (error && error.message));
                this._onErrorHelper(error);
                return;
            }

            this._getShallowDirectorySize(this._tempDir, (err, size) => {
                if (err || size < 0) {
                    Logging.warn(Sender.TAG, "Error while checking directory size: " + (err && err.message));
                    this._onErrorHelper(err);
                    return;
                } else if (size > this._maxBytesOnDisk) {
                    Logging.warn(Sender.TAG, "Not saving data due to max size limit being met. Directory size in bytes is: " + size);
                    return;
                }

                //create file - file name for now is the timestamp, a better approach would be a UUID but that
                //would require an external dependency
                var fileName = new Date().getTime() + ".ai.json";
                var fileFullPath = path.join(this._tempDir, fileName);

                // Mode 600 is w/r for creator and no read access for others (only applies on *nix)
                // For Windows, ACL rules are applied to the entire directory (see logic in _confirmDirExists and _applyACLRules)
                Logging.info(Sender.TAG, "saving data to disk at: " + fileFullPath);
                fs.writeFile(fileFullPath, this._stringify(envelopes), { mode: 0o600 }, (error) => this._onErrorHelper(error));
            });
        });
    }

    /**
     * Stores the payload as a json file on disk using sync file operations
     * this is used when storing data before crashes
     */
    private _storeToDiskSync(payload: any) {
        try {
            Logging.info(Sender.TAG, "Checking existence of data storage directory: " + this._tempDir);
            if (!fs.existsSync(this._tempDir)) {
                fs.mkdirSync(this._tempDir);
            }

            // Make sure permissions are valid
            this._applyACLRulesSync(this._tempDir);

            let dirSize = this._getShallowDirectorySizeSync(this._tempDir);
            if (dirSize > this._maxBytesOnDisk) {
                Logging.info(Sender.TAG, "Not saving data due to max size limit being met. Directory size in bytes is: " + dirSize);
                return;
            }

            //create file - file name for now is the timestamp, a better approach would be a UUID but that
            //would require an external dependency
            var fileName = new Date().getTime() + ".ai.json";
            var fileFullPath = path.join(this._tempDir, fileName);

            // Mode 600 is w/r for creator and no access for anyone else (only applies on *nix)
            Logging.info(Sender.TAG, "saving data before crash to disk at: " + fileFullPath);
            fs.writeFileSync(fileFullPath, payload, { mode: 0o600 });

        } catch (error) {
            Logging.warn(Sender.TAG, "Error while saving data to disk: " + (error && error.message));
            this._onErrorHelper(error);
        }
    }

    /**
     * Check for temp telemetry files
     * reads the first file if exist, deletes it and tries to send its load
     */
    private _sendFirstFileOnDisk(): void {

        fs.exists(this._tempDir, (exists: boolean) => {
            if (exists) {
                fs.readdir(this._tempDir, (error, files) => {
                    if (!error) {
                        files = files.filter(f => path.basename(f).indexOf(".ai.json") > -1);
                        if (files.length > 0) {
                            var firstFile = files[0];
                            var filePath = path.join(this._tempDir, firstFile);
                            fs.readFile(filePath, (error, buffer) => {
                                if (!error) {
                                    // delete the file first to prevent double sending
                                    fs.unlink(filePath, (error) => {
                                        if (!error) {
                                            try {
                                                let envelopes: Contracts.EnvelopeTelemetry[] = JSON.parse(buffer.toString());
                                                this.send(envelopes);
                                            }
                                            catch (error) {
                                                Logging.warn("Failed to read persisted file", error);
                                            }
                                        } else {
                                            this._onErrorHelper(error);
                                        }
                                    });
                                } else {
                                    this._onErrorHelper(error);
                                }
                            });
                        }
                    } else {
                        this._onErrorHelper(error);
                    }
                });
            }
        });
    }

    private _onErrorHelper(error: Error): void {
        if (typeof this._onError === "function") {
            this._onError(error);
        }
    }

    private _stringify(payload: any) {
        try {
            return JSON.stringify(payload);
        } catch (error) {
            Logging.warn("Failed to serialize payload", error, payload);
        }
    }

    private _fileCleanupTask() {
        fs.exists(this._tempDir, (exists: boolean) => {
            if (exists) {
                fs.readdir(this._tempDir, (error, files) => {
                    if (!error) {
                        files = files.filter(f => path.basename(f).indexOf(".ai.json") > -1);
                        if (files.length > 0) {

                            files.forEach(file => {
                                // Check expiration
                                let fileCreationDate: Date = new Date(parseInt(file.split(".ai.json")[0]));
                                let expired = new Date(+(new Date()) - Sender.FILE_RETEMPTION_PERIOD) > fileCreationDate;
                                if (expired) {
                                    var filePath = path.join(this._tempDir, file);
                                    fs.unlink(filePath, (error) => {
                                        if (error) {
                                            this._onErrorHelper(error);
                                        }
                                    });
                                }
                            });
                        }
                    } else {
                        this._onErrorHelper(error);
                    }
                });
            }
        });
    }
}

export = Sender;
