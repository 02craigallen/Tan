const { CosmosClient } = require("@azure/cosmos");

async function main() {
    const client = new CosmosClient({ endpoint: process.env.COSMOS_ENDPOINT, key: process.env.COSMOS_KEY });
    const container = client.database("tan-db").container("kv");
    const people = [
        { id: "seed-combes", name: "FF Combes", payrollNumber: "", rank: "Firefighter", watch: "Red", phone: "", emergencyName: "", emergencyPhone: "" },
        { id: "seed-ryan", name: "FF Ryan", payrollNumber: "", rank: "Firefighter", watch: "Blue", phone: "", emergencyName: "", emergencyPhone: "" },
        { id: "seed-pleasants", name: "FF Pleasants", payrollNumber: "", rank: "Firefighter", watch: "Green", phone: "", emergencyName: "", emergencyPhone: "" },
    ];
    await container.items.upsert({ id: "people:list", value: people, updatedAt: new Date().toISOString() });
    console.log("Seeded people:list with", people.length, "people");
}
main().catch((e) => { console.error(e); process.exit(1); });
