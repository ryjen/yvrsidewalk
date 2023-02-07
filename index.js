// 1. Listens to payments to [ADDRESS}
// 2. Decodes the inputs
// 3. Pings sidewalk controller

require("dotenv").config();
const ethers = require("ethers");

const ENV_VARS = ["RPC_URL", "MULTISIG_ADDRESS"];
for (let i = 0; i < ENV_VARS.length; i++) {
  const envVar = ENV_VARS[i];
  if (process.env[envVar] === undefined) {
    console.log(`Missing ${envVar} environment variable`);
    process.exit(1);
  }
}
const RPC_URL = process.env.RPC_URL;
const MULTISIG_ADDRESS = process.env.MULTISIG_ADDRESS.toLowerCase();

const provider = new ethers.providers.JsonRpcProvider(RPC_URL);

let queue = [];

setInterval(() => {
  // Make sure queue is > 0
  if (queue.length === 0) {
    return;
  }

  // Shift
  const curString = queue.shift();

  // TODO:
  console.log(`Changing text to ${curString}`);
  fetch("http://192.168.1.51:3456/startshow", {
    headers: {
      accept: "*/*",
      "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "x-requested-with": "XMLHttpRequest",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    },
    body: `show=Banner&banner=${curString}&imgShow=orangeDot`,
    method: "POST",
  })
    .then(() => {
      console.log("successfully changed text");
    })
    .catch(() => {
      console.log("failed to change text");
    });
}, 1 * 60 * 1000);

const onBlock = async (b) => {
  const block = await provider.getBlockWithTransactions(b);
  const relevantTxs = block.transactions
    .filter((x) => (x.to || "").toLowerCase() === MULTISIG_ADDRESS)
    .filter((x) =>
      (x.value || ethers.constants.Zero).gte(ethers.utils.parseUnits("1"))
    );

  console.log(b, "relevantTxs", relevantTxs);

  // Add to the queue
  relevantTxs.forEach((x) => {
    // Max 64 characters
    const str = ethers.utils.toUtf8String(x.data).slice(0, 64);
    queue.push(str);
  });
};

provider.on("block", (b) => {
  onBlock(b);
});
