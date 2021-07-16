
import Config = require("./Config");
import Logging = require("./Logging");
import Util = require("./Util");
import AutoCollectHttpDependencies = require("../AutoCollection/HttpDependencies");

const AIMS_URI = "http://169.254.169.254/metadata/instance/compute";
const AIMS_API_VERSION = "api-version=2017-12-01";
const AIMS_FORMAT = "format=json";

export interface IVirtualMachineInfo {
    isVM: boolean;
    id?: string;
    subscriptionId?: string;
    osType?: string;
}

export class AzureVirtualMachine {

    private static TAG = "AzureVirtualMachine";

    public static getAzureComputeMetadata(config: Config) {
        let vmInfo: IVirtualMachineInfo = {
            isVM: false,
            id: "",
            subscriptionId: "",
            osType: "",
        };
        const metadataRequestUrl = `${AIMS_URI}?${AIMS_API_VERSION}&${AIMS_FORMAT}`;
        const requestOptions = {
            method: 'GET',
            [AutoCollectHttpDependencies.disableCollectionRequestOption]: true,
            headers: {
                "Metadata": "True",
            }
        };

        const req = Util.makeRequest(config, metadataRequestUrl, requestOptions, (res) => {
            if (res.statusCode === 200) {
                // Success; VM
                vmInfo.isVM = true;
                let virtualMachineData = "";
                res.on('data', (data: any) => {
                    virtualMachineData += data;
                });
                res.on('end', () => {
                    try {
                        let data = JSON.parse(virtualMachineData);
                        vmInfo.id = data["vmId"] || "";
                        vmInfo.subscriptionId = data["subscriptionId"] || "";
                        vmInfo.osType = data["osType"] || "";
                    }
                    catch (error) {
                        // Failed to parse JSON
                        Logging.warn(AzureVirtualMachine.TAG, error);
                    }
                    return vmInfo;
                });
            }
        });
        if (req) {
            req.on('error', (error: Error) => {
                // Unable to contact endpoint.
                // Do nothing for now.
                Logging.warn(AzureVirtualMachine.TAG, error);
            });
            req.end();
            return vmInfo;
        }
    }
}
