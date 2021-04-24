// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

// Don't reference modules from these directly. Use only for types.
// This is to avoid requiring the actual module if the NO_DIAGNOSTIC_CHANNEL env is present
import * as DiagChannelPublishers from "diagnostic-channel-publishers";
import * as DiagChannel from "diagnostic-channel";
import { AsyncScopeManager } from "../AsyncHooksScopeManager";
import Logging = require("../../Library/Logging");

export const IsInitialized = !process.env["APPLICATION_INSIGHTS_NO_DIAGNOSTIC_CHANNEL"];
const TAG = "DiagnosticChannel";

if (IsInitialized) {
    const publishers: typeof DiagChannelPublishers = require("diagnostic-channel-publishers");
    const individualOptOuts: string = process.env["APPLICATION_INSIGHTS_NO_PATCH_MODULES"] || "";
    const unpatchedModules = individualOptOuts.split(",");
    const modules: {[key: string] : any} = {
        bunyan: publishers.bunyan,
        console: publishers.console,
        mongodb: publishers.mongodb,
        mongodbCore: publishers.mongodbCore,
        mysql: publishers.mysql,
        redis: publishers.redis,
        pg: publishers.pg,
        pgPool: publishers.pgPool,
        tedious: publishers.tedious,
        winston: publishers.winston,
        azuresdk: publishers.azuresdk
    };
    for (const mod in modules) {
        if (unpatchedModules.indexOf(mod) === -1) {
            modules[mod].enable();
            Logging.info(TAG, `Subscribed to ${mod} events`);
        }
    }
    if (unpatchedModules.length > 0) {
        Logging.info(TAG, "Some modules will not be patched", unpatchedModules);
    }
} else {
    Logging.info(TAG, "Not subscribing to dependency autocollection because APPLICATION_INSIGHTS_NO_DIAGNOSTIC_CHANNEL was set");
}

export function registerContextPreservation(cb: (cb: Function) => Function) {
    if (!IsInitialized) {
        return;
    }
    const diagChannel = (require("diagnostic-channel") as typeof DiagChannel);
    diagChannel.channel.addContextPreservation(cb);
    diagChannel.channel.spanContextPropagator = AsyncScopeManager;
}
