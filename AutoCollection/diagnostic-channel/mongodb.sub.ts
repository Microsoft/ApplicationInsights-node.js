// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.
import TelemetryClient = require("../../Library/TelemetryClient");
import { StatsbeatInstrumentation } from "../../Declarations/Constants";
import { channel, IStandardEvent } from "diagnostic-channel";

import { mongodb } from "diagnostic-channel-publishers";

let clients: TelemetryClient[] = [];

export const subscriber = (event: IStandardEvent<mongodb.IMongoData>) => {
    if (event.data.event.commandName === "ismaster") {
        // suppress noisy ismaster commands
        return;
    }
    clients.forEach((client) => {
        const dbName = (event.data.startedData && event.data.startedData.databaseName) || "Unknown database";
        client.trackDependency(
            {
                target: dbName,
                data: event.data.event.commandName,
                name: event.data.event.commandName,
                duration: event.data.event.duration,
                success: event.data.succeeded,
                /* TODO: transmit result code from mongo */
                resultCode: event.data.succeeded ? "0" : "1",
                time: event.data.startedData.time,
                dependencyTypeName: 'mongodb'
            });
    });
};

export function enable(enabled: boolean, client: TelemetryClient) {
    let statsbeat = client.getStatsbeat();
    if (enabled) {
        if (clients.length === 0) {
            channel.subscribe<mongodb.IMongoData>("mongodb", subscriber);
            if (statsbeat) {
                statsbeat.addInstrumentation(StatsbeatInstrumentation.MONGODB);
            }
        };
        clients.push(client);
    } else {
        clients = clients.filter((c) => c != client);
        if (clients.length === 0) {
            channel.unsubscribe("mongodb", subscriber);
            if (statsbeat) {
                statsbeat.removeInstrumentation(StatsbeatInstrumentation.MONGODB);
            }
        }
    }
}
