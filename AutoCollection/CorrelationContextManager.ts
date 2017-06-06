import http = require("http");
import Util = require("../Library/Util");

import {channel} from "diagnostic-channel";

export interface CorrelationContext {
    operation: {
        name: string;
        id: string;
        parentId: string; // Always used for dependencies, may be ignored in favor of incoming headers for requests
    };

    /** Do not store sensitive information here. 
     *  Properties here can be exposed in a future SDK release via outgoing HTTP headers for correlating data cross-component.
     */
    customProperties: { 
        addHeaderData(header: string): void;
        getProperty(prop: string): string;
        setProperty(prop: string, val: string): void;
        serializeToHeader(): string;
     };
}

export class CorrelationContextManager {
    private static enabled: boolean = false;
    private static hasEverEnabled: boolean = false;

    /** 
     *  Provides the current Context.
     *  The context is the most recent one entered into for the current
     *  logical chain of execution, including across asynchronous calls.
     */
    public static getCurrentContext(): CorrelationContext {
        if (!CorrelationContextManager.enabled) {
            return null;
        }
        return Zone.current.get("context");
    }

    /**
     *  A helper to generate objects conforming to the CorrelationContext interface
     */
    public static generateContextObject(operationId: string, parentId?: string, operationName?: string, correlationContextHeader?: string): CorrelationContext {
        parentId = parentId || operationId;

        const bannedCharacters = /[,=]/;

        const customProperties: any = {
            props: []
        }
        customProperties.addHeaderData = function (header: string) {
            header = header || "";
            this.props = header.split(", ").map((keyval) => {
                const parts = keyval.split("=");
                return {key: parts[0], value: parts[1]};
            }).concat(this.props);
        }.bind(customProperties);

        customProperties.serializeToHeader = function () {
            return this.props.map((keyval) => {
                `${keyval.key}=${keyval.value}`
            }).join(", ");
        }.bind(customProperties);

        customProperties.getProperty = function (prop: string) {
            for(let i = 0; i < this.props.length; ++i) {
                const keyval = this.props[i]
                if (keyval.key === prop) {
                    return keyval.value;
                }
            }
            return;
        }.bind(customProperties);

        customProperties.addHeaderData(correlationContextHeader);

        // TODO: Strictly according to the spec, properties which are recieved from
        // an incoming request should be left untouched, while we may add our own new
        // properties. The logic here will need to change to track that.
        customProperties.setProperty = function (prop: string, val: string) {
            if (bannedCharacters.test(prop) || bannedCharacters.test(val)) {
                throw new Error("Keys and values must not contain ',' or '='");
            }
            for(let i = 0; i < this.props.length; ++i) {
                const keyval = this.props[i];
                if (keyval.key === prop) {
                    keyval.value = val;
                    return;
                }
            }
            this.props.push({key: prop, value: val});
        }.bind(customProperties);


        if (this.enabled) {
            return {
                operation: {
                    name: operationName,
                    id: operationId,
                    parentId: parentId
                },
                customProperties
            };
        }

        return null;
    }

    /** 
     *  Runs a function inside a given Context.
     *  All logical children of the execution path that entered this Context
     *  will receive this Context object on calls to GetCurrentContext.
     */
    public static runWithContext(context: CorrelationContext, fn: ()=>any) {
        if (CorrelationContextManager.enabled) {
            var newZone = Zone.current.fork({
                name: "AI-" + ((context && context.operation.parentId) || "Unknown"), 
                properties: {context: context}
            });
            newZone.run(fn);
        } else {
            fn();
        }
    }

    /** 
     *  Patches a callback to restore the correct Context when getCurrentContext 
     *  is run within it. This is necessary if automatic correlation fails to work
     *  with user-included libraries.
     * 
     *  The supplied callback will be given the same context that was present for 
     *  the call to wrapCallback.  */
    public static wrapCallback<T extends Function>(fn: T): T {
        if (CorrelationContextManager.enabled) {
            return Zone.current.wrap(fn, "User-wrapped method");
        }
        return fn;
    }

    /**
     *  Enables the CorrelationContextManager.
     */
    public static enable() {
        if (!this.isNodeVersionCompatible()) {
            this.enabled = false;
            return;
        }

        // Load in Zone.js
        require("zone.js");
        

        // Run patches for Zone.js
        if (!this.hasEverEnabled) {
            this.hasEverEnabled = true;
            channel.addContextPreservation((cb) => {
                return Zone.current.wrap(cb, "AI-ContextPreservation");
            })
            this.patchError();
            this.patchTimers(["setTimeout", "setInterval"]);
        }

        this.enabled = true;
    }

    /**
     *  Disables the CorrelationContextManager.
     */
    public static disable() {
        this.enabled = false;
    }


    /**
     *  Reports if the CorrelationContextManager is able to run in this environment
     */
    public static isNodeVersionCompatible() {
        // Unit tests warn of errors < 3.3 from timer patching. All versions before 4 were 0.x
        var nodeVer = process.versions.node.split(".");
        return parseInt(nodeVer[0]) > 3 || (parseInt(nodeVer[0]) > 2 && parseInt(nodeVer[1]) > 2);
    }

    // Patch methods that manually go async that Zone doesn't catch
    private static requireForPatch(module: string) {
        var req = null;
        try {
            req = require(module);
        } catch (e) {
            return null;
        }
        return req;
    }

    // Zone.js breaks concatenation of timer return values.
    // This fixes that.
    private static patchTimers(methodNames: string[]) {
        methodNames.forEach(methodName => {
            var orig = global[methodName];
            global[methodName] = function() {
                var ret = orig.apply(this, arguments);
                ret.toString = function(){
                    if (this.data && typeof this.data.handleId !== 'undefined') {
                        return this.data.handleId.toString();
                    } else {
                        return Object.prototype.toString.call(this);
                    }
                }
                return ret;
            };
        });
    }

    // Zone.js breaks deepEqual on error objects (by making internal properties enumerable).
    // This fixes that by subclassing the error object and making all properties not enumerable
    private static patchError() {
        var orig = global.Error;

        // New error handler
        function AppInsightsAsyncCorrelatedErrorWrapper() {
            if (!(this instanceof AppInsightsAsyncCorrelatedErrorWrapper)) {
                return AppInsightsAsyncCorrelatedErrorWrapper.apply(Object.create(AppInsightsAsyncCorrelatedErrorWrapper.prototype), arguments);
            }

            // Is this object set to rewrite the stack?
            // If so, we should turn off some Zone stuff that is prone to break
            var stackRewrite = (<any>orig).stackRewrite;
            if ((<any>orig).prepareStackTrace) {
                (<any>orig).stackRewrite= false;
                var stackTrace = (<any>orig).prepareStackTrace;
                (<any>orig).prepareStackTrace = (e, s) => {
                    // Remove some AI and Zone methods from the stack trace
                    // Otherwise we leave side-effects

                    // Algorithm is to find the first frame on the stack after the first instance(s)
                    // of AutoCollection/CorrelationContextManager
                    // Eg. this should return the User frame on an array like below:
                    //  Zone | Zone | CorrelationContextManager | CorrelationContextManager | User
                    var foundOne = false;
                    for (var i=0; i<s.length; i++) {
                        if (s[i].getFileName().indexOf("AutoCollection/CorrelationContextManager") === -1 &&
                            s[i].getFileName().indexOf("AutoCollection\\CorrelationContextManager") === -1) {

                            if (foundOne) {
                                break;
                            }
                        } else {
                            foundOne = true;
                        }
                    }
                    // Loop above goes one extra step
                    i = Math.max(0, i - 1);
                    
                    s.splice(0, i);
                    return stackTrace(e, s);
                }
            }

            // Apply the error constructor
            orig.apply(this, arguments);

            // Restore Zone stack rewriting settings
            (<any>orig).stackRewrite = stackRewrite;
            
            // getOwnPropertyNames should be a superset of Object.keys...
            // This appears to not always be the case
            var props = Object.getOwnPropertyNames(this).concat(Object.keys(this));

            // Zone.js will automatically create some hidden properties at read time.
            // We need to proactively make those not enumerable as well as the currently visible properties
            for(var i=0; i < props.length; i++) {
                var propertyName = props[i];
                var hiddenPropertyName = Zone['__symbol__'](propertyName);
                Object.defineProperty(this, propertyName, { enumerable: false });
                Object.defineProperty(this, hiddenPropertyName, { enumerable: false, writable: true });
            }

            return this;
        }

        // Inherit from the Zone.js error handler
        AppInsightsAsyncCorrelatedErrorWrapper.prototype = orig.prototype;

        // We need this loop to copy outer methods like Error.captureStackTrace
        var props = Object.getOwnPropertyNames(orig);
        for(var i=0; i < props.length; i++) {
            var propertyName = props[i];
            if (!AppInsightsAsyncCorrelatedErrorWrapper[propertyName]) {
                Object.defineProperty(AppInsightsAsyncCorrelatedErrorWrapper, propertyName, Object.getOwnPropertyDescriptor(orig, propertyName));
            }
        }
        
        // explicit cast to <any> required to avoid type error for captureStackTrace
        // with latest node.d.ts (despite workaround above)
        global.Error = <any>AppInsightsAsyncCorrelatedErrorWrapper;
    }
}
