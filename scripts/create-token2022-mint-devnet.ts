import * as anchor from "@coral-xyz/anchor";

import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  Connection,
  clusterApiUrl,
} from "@solana/web3.js";

import {
  TOKEN_2022_PROGRAM_ID,
  MINT_SIZE,
  createInitializeMint2Instruction,
  getMint,
  getMinimumBalanceForRentExemptMint,
} from "@solana/spl-token";

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ============================================================
// Config
// ============================================================

// 你的合约 Program ID
const PROGRAM_ID = new PublicKey(
  "D5phW6cTmBdJuuM2WCib2SjvLHcegcFCb4UB38TABPaq"
);

// Token decimals，必须和合约一致
const TOKEN_DECIMALS = 9;

// 默认 devnet RPC
const RPC_URL = "https://api.devnet.solana.com";

// 默认使用 Solana CLI 当前钱包
const DEFAULT_KEYPAIR_PATH = path.join(
  os.homedir(),
  ".config",
  "solana",
  "id.json"
);

// 如果你要指定钱包路径，改这里
const KEYPAIR_PATH = process.env.ANCHOR_WALLET || DEFAULT_KEYPAIR_PATH;

// ============================================================
// Helpers
// ============================================================

function loadKeypair(filePath: string): Keypair {
  const raw = fs.readFileSync(filePath, "utf-8");
  const secret = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(secret);
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");

  const payer = loadKeypair(KEYPAIR_PATH);

  console.log("========================================");
  console.log("Create Token-2022 Mint on Devnet");
  console.log("========================================");
  console.log("RPC:", RPC_URL);
  console.log("Payer:", payer.publicKey.toBase58());
  console.log("Program ID:", PROGRAM_ID.toBase58());

  // ============================================================
  // 1. 派生合约 mint_authority PDA
  // ============================================================

  const [mintAuthorityPda, mintAuthorityBump] =
    PublicKey.findProgramAddressSync(
      [Buffer.from("mint_authority")],
      PROGRAM_ID
    );

  console.log("----------------------------------------");
  console.log("Mint Authority PDA");
  console.log("----------------------------------------");
  console.log("mint_authority PDA:", mintAuthorityPda.toBase58());
  console.log("mint_authority bump:", mintAuthorityBump);

  // ============================================================
  // 2. 创建新的 mint keypair
  // ============================================================

  const mintKeypair = Keypair.generate();

  console.log("----------------------------------------");
  console.log("New Mint");
  console.log("----------------------------------------");
  console.log("new mint address:", mintKeypair.publicKey.toBase58());

  // ============================================================
  // 3. 创建 Token-2022 mint account
  // ============================================================

  const lamports = await getMinimumBalanceForRentExemptMint(connection);

  const createMintAccountIx = SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: mintKeypair.publicKey,
    space: MINT_SIZE,
    lamports,
    programId: TOKEN_2022_PROGRAM_ID,
  });

  // freezeAuthority = null
  // mintAuthority = mintAuthorityPda
  const initializeMintIx = createInitializeMint2Instruction(
    mintKeypair.publicKey,
    TOKEN_DECIMALS,
    mintAuthorityPda,
    null,
    TOKEN_2022_PROGRAM_ID
  );

  const tx = new Transaction().add(
    createMintAccountIx,
    initializeMintIx
  );

  const sig = await sendAndConfirmTransaction(
    connection,
    tx,
    [payer, mintKeypair],
    {
      commitment: "confirmed",
    }
  );

  console.log("----------------------------------------");
  console.log("Transaction");
  console.log("----------------------------------------");
  console.log("signature:", sig);

  // ============================================================
  // 4. 读取并校验 mint
  // ============================================================

  const mintInfo = await getMint(
    connection,
    mintKeypair.publicKey,
    "confirmed",
    TOKEN_2022_PROGRAM_ID
  );

  console.log("----------------------------------------");
  console.log("Mint Info");
  console.log("----------------------------------------");
  console.log("mint:", mintKeypair.publicKey.toBase58());
  console.log("decimals:", mintInfo.decimals);
  console.log(
    "mint authority:",
    mintInfo.mintAuthority
      ? mintInfo.mintAuthority.toBase58()
      : "null"
  );
  console.log(
    "freeze authority:",
    mintInfo.freezeAuthority
      ? mintInfo.freezeAuthority.toBase58()
      : "null"
  );
  console.log("supply:", mintInfo.supply.toString());
  console.log("token program:", TOKEN_2022_PROGRAM_ID.toBase58());

  // ============================================================
  // 5. 强制校验
  // ============================================================

  if (mintInfo.decimals !== TOKEN_DECIMALS) {
    throw new Error(
      `Invalid decimals. Expected ${TOKEN_DECIMALS}, got ${mintInfo.decimals}`
    );
  }

  if (
    mintInfo.mintAuthority === null ||
    !mintInfo.mintAuthority.equals(mintAuthorityPda)
  ) {
    throw new Error(
      [
        "Invalid mint authority.",
        `Expected: ${mintAuthorityPda.toBase58()}`,
        `Actual: ${
          mintInfo.mintAuthority
            ? mintInfo.mintAuthority.toBase58()
            : "null"
        }`,
      ].join("\n")
    );
  }

  if (mintInfo.freezeAuthority !== null) {
    throw new Error(
      `Invalid freeze authority: ${mintInfo.freezeAuthority.toBase58()}`
    );
  }

  console.log("----------------------------------------");
  console.log("Token-2022 mint created successfully.");
  console.log("----------------------------------------");
  console.log("");
  console.log("Use this mint address in initialize script:");
  console.log("");
  console.log(`const GNUMER_MINT = new PublicKey("${mintKeypair.publicKey.toBase58()}");`);
  console.log("");
}

main().catch((err) => {
  console.error("----------------------------------------");
  console.error("Create Token-2022 mint failed");
  console.error("----------------------------------------");
  console.error(err);
  process.exit(1);
});
