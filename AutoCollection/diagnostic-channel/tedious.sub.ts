// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.
import TelemetryClient = require("../../Library/TelemetryClient");
import { channel, IStandardEvent } from "diagnostic-channel";

import { ITediousData } from "diagnostic-channel-publishers/dist/src/tedious.pub";

let clients: TelemetryClient[] = [];

export const subscriber = (event: IStandardEvent<ITediousData>) => {
    clients.forEach((client) => {
        const q = event.data.query;
        const sql = (q.preparable && q.preparable.text) || q.plan || q.text || "unknown query";
        const success = !event.data.error;
        const conn = `${event.data.database.host}:${event.data.database.port}`;
        client.trackDependency({
            target: conn,
            data: sql,
            name: sql,
            duration: event.data.duration,
            success: success,
            resultCode: success ? "0" : "1",
            dependencyTypeName: "mssql"
        });
    });
};

export function enable(enabled: boolean, client: TelemetryClient) {
    if (enabled) {
        if (clients.length === 0) {
            channel.subscribe<ITediousData>("tedious", subscriber);
        };
        clients.push(client);
    } else {
        clients = clients.filter((c) => c != client);
        if (clients.length === 0) {
            channel.unsubscribe<ITediousData>("tedious", subscriber);
        }
    }
}
