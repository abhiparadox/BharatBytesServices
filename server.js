require("dotenv").config();
const express = require("express");
const fs = require("fs");
const { ethers } = require("ethers");
const cron = require("node-cron");
const cors = require("cors");
const bodyParser = require("body-parser");

// Load environment variables
const { PORT, INFURA_API_KEY, PRIVATE_KEY, CONTRACT_ADDRESS } = process.env;
if (!INFURA_API_KEY) {
  throw new Error("Infura API key is missing. Check your .env file.");
}
if (!PRIVATE_KEY) {
  throw new Error("Private key is missing. Check your .env file.");
}

// Initialize Express app
const app = express();
app.use(cors());
app.use(bodyParser.json());

const DB_FILE = "db.json";

// Load database
const loadDatabase = () => {
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
};

// Save database
const saveDatabase = (data) => {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), "utf8");
};

// Connect to Ethereum
const provider = new ethers.providers.InfuraProvider("sepolia", INFURA_API_KEY);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const abi = [
  "function issueTokens(address account, uint256 amount) external",
  "function redeemTokens(address account, uint256 amount) external",
  "function _transfer(address sender, address recipient, uint256 amount) external",
  "function autoSettle(address account) external",
  "function balanceOf(address owner) view returns (uint256)",
];

const contract = new ethers.Contract(CONTRACT_ADDRESS, abi, wallet);

// Function to update database from blockchain
async function syncGoldByteBalance(wallet_address) {
  const balance = await contract.balanceOf(wallet_address);
  const goldByte = ethers.utils.formatUnits(balance, 18);

  let db = loadDatabase();
  let account = db.accounts.find(
    (acc) => acc.wallet_address === wallet_address
  );
  if (account) {
    account.goldbyte = parseFloat(goldByte);
    saveDatabase(db);
  }
}

// API to issue GoldByte tokens
app.post("/issue", async (req, res) => {
  const { account_number, goldbytes } = req.body;
  let db = loadDatabase();
  let account = db.accounts.find(
    (acc) => acc.account_number === account_number
  );

  if (!account) return res.status(404).json({ error: "Account not found" });

  try {
    const tx = await contract.issueTokens(
      account.wallet_address,
      ethers.utils.parseUnits(goldbytes.toString(), 18)
    );
    await tx.wait();

    account.goldbyte += goldbytes;
    account.validity = 5;
    saveDatabase(db);

    res.json({ status: "issued", goldbyte: goldbytes, validity: 5 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API to redeem GoldByte tokens
app.post("/redeem", async (req, res) => {
  const { account_number, goldbytes } = req.body;
  let db = loadDatabase();
  let account = db.accounts.find(
    (acc) => acc.account_number === account_number
  );

  if (!account) return res.status(404).json({ error: "Account not found" });

  try {
    const tx = await contract.redeemTokens(
      account.wallet_address,
      ethers.utils.parseUnits(goldbytes.toString(), 18)
    );
    await tx.wait();

    await syncGoldByteBalance(account.wallet_address);
    res.json({ status: "redeemed", goldbyte: goldbytes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API to transfer GoldByte tokens
app.post("/transfer", async (req, res) => {
  const { from_wallet, to_wallet, goldbytes } = req.body;

  try {
    const tx = await contract._transfer(
      from_wallet,
      to_wallet,
      ethers.utils.parseUnits(goldbytes.toString(), 18)
    );
    await tx.wait();

    await syncGoldByteBalance(from_wallet);
    await syncGoldByteBalance(to_wallet);

    res.json({ status: "transferred", goldbyte: goldbytes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API to get account details
app.get("/account/:account_number", async (req, res) => {
  const { account_number } = req.params;
  let db = loadDatabase();
  let account = db.accounts.find(
    (acc) => acc.account_number === account_number
  );

  if (!account) return res.status(404).json({ error: "Account not found" });

  await syncGoldByteBalance(account.wallet_address);
  res.json(account);
});

// Cron job to decrease validity and auto-settle expired tokens
cron.schedule("0 0 * * *", async () => {
  let db = loadDatabase();

  for (let account of db.accounts) {
    account.validity = Math.max(0, account.validity - 1);

    if (account.validity === 0) {
      try {
        const tx = await contract.autoSettle(account.wallet_address);
        await tx.wait();
        await syncGoldByteBalance(account.wallet_address);
      } catch (error) {
        console.error("Auto-settlement error:", error);
      }
    }
  }

  saveDatabase(db);
  console.log("Validity updated and expired tokens settled.");
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
