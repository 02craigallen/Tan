const { CosmosClient } = require("@azure/cosmos");

let client = null;
function getClient() {
    if (!client) {
        client = new CosmosClient({
            endpoint: process.env.COSMOS_ENDPOINT,
            key: process.env.COSMOS_KEY,
        });
    }
    return client;
}

function container(name) {
    return getClient().database("tan-db").container(name);
}

const ensuredContainers = new Set();
async function ensureContainer(name, partitionKeyPath) {
    if (ensuredContainers.has(name)) return;
    await getClient().database("tan-db").containers.createIfNotExists({ id: name, partitionKey: { paths: [partitionKeyPath] } });
    ensuredContainers.add(name);
}

async function readDoc(containerName, id) {
    try {
        const { resource } = await container(containerName).item(id, id).read();
        return resource || null;
    }
    catch (err) {
        if (err.code === 404) return null;
        throw err;
    }
}

async function upsertDoc(containerName, doc) {
    await container(containerName).items.upsert(doc);
}

module.exports = { container, readDoc, upsertDoc, ensureContainer };
