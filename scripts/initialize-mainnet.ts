import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, Program, Wallet, Idl } from "@coral-xyz/anchor";

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";

import {
  TOKEN_2022_PROGRAM_ID,
  getMint,
} from "@solana/spl-token";

import * as fs from "fs";
import * as path from "path";

// ============================================================
// Mainnet Config
// ============================================================

// 主网 RPC
const RPC_URL = "https://api.mainnet-beta.solana.com";

// 已部署的主网 Program ID
const PROGRAM_ID = new PublicKey(
  "9rckADaKzwyoRDmLDzQWANLTzFM3WX9rdRuspkUVymCX"
);

// 源码中写死的初始化钱包
const EXPECTED_INITIALIZER = new PublicKey(
  "4fXxndc4h2Zsi35YxVKYSJxFdJ5nTqAZ1Bk64M6acRpC"
);

// 初始化钱包 keypair 路径。
// 这个 keypair 的 pubkey 必须是 4fXx...
const INITIALIZER_KEYPAIR_PATH = "/home/lb/wallet.json";

// 你的主网 Token-2022 GNUMER mint。
// 按你前面创建的新 mint，这里先填 7ybm...
// 如果你最终使用的 mint 不是这个，替换成真实 mint。
const GNUMER_MINT = new PublicKey(
  "7ybmQBZB51YAb8bTVhvkPpXeArc9fqa17qNTbbQu2d8w"
);

// 你的主网 treasury / 多签钱包。
// 必须替换成真实收 SOL 的多签钱包地址。
const TREASURY_WALLET = new PublicKey(
  "GJSkxADWJ7svacJdqvJRApBjGgHiLnY3yewSfTnboUB7"
);

// 合约要求 decimals = 9
const TOKEN_DECIMALS = 9;

// IDL 路径
const IDL_PATH = path.join(
  process.cwd(),
  "target",
  "idl",
  "gnumer_sale.json"
);

// ============================================================
// Helpers
// ============================================================

function loadKeypair(filePath: string): Keypair {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Keypair file not found: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const secret = Uint8Array.from(JSON.parse(raw));

  return Keypair.fromSecretKey(secret);
}

function loadIdl(): Idl {
  if (!fs.existsSync(IDL_PATH)) {
    throw new Error(
      [
        `IDL not found: ${IDL_PATH}`,
        "",
        "请先执行：",
        "anchor build",
      ].join("\n")
    );
  }

  const raw = fs.readFileSync(IDL_PATH, "utf-8");
  const idl = JSON.parse(raw);

  // 强制使用主网 Program ID，避免 IDL address 不一致
  idl.address = PROGRAM_ID.toBase58();

  return idl;
}

function sol(lamports: number | bigint | string): number {
  return Number(lamports) / LAMPORTS_PER_SOL;
}

function printSection(title: string) {
  console.log("");
  console.log("----------------------------------------");
  console.log(title);
  console.log("----------------------------------------");
}

async function main() {
  console.log("========================================");
  console.log("Gnumer Mainnet Initialize");
  console.log("========================================");

  const connection = new Connection(RPC_URL, "confirmed");

  const initializerKeypair = loadKeypair(INITIALIZER_KEYPAIR_PATH);
  const wallet = new Wallet(initializerKeypair);

  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
    skipPreflight: false,
  });

  anchor.setProvider(provider);

  const idl = loadIdl();
  const program = new Program(idl, provider) as any;

  const initializer = wallet.publicKey;

  console.log("RPC:", RPC_URL);
  console.log("Program ID:", PROGRAM_ID.toBase58());
  console.log("Initializer keypair:", INITIALIZER_KEYPAIR_PATH);
  console.log("Initializer pubkey:", initializer.toBase58());
  console.log("Expected initializer:", EXPECTED_INITIALIZER.toBase58());
  console.log("GNUMER mint:", GNUMER_MINT.toBase58());
  console.log("Treasury wallet:", TREASURY_WALLET.toBase58());

  // ============================================================
  // 1. Basic checks
  // ============================================================

  printSection("1. Basic Checks");

  if (!program.programId.equals(PROGRAM_ID)) {
    throw new Error(
      [
        "Program ID mismatch.",
        `Expected: ${PROGRAM_ID.toBase58()}`,
        `Actual:   ${program.programId.toBase58()}`,
      ].join("\n")
    );
  }

  if (!initializer.equals(EXPECTED_INITIALIZER)) {
    throw new Error(
      [
        "Invalid initializer wallet.",
        `Current:  ${initializer.toBase58()}`,
        `Expected: ${EXPECTED_INITIALIZER.toBase58()}`,
        "",
        "当前 keypair 不是源码中写死的 INITIALIZER_WALLET。",
      ].join("\n")
    );
  }

  if (GNUMER_MINT.equals(PublicKey.default)) {
    throw new Error("Invalid GNUMER_MINT: default pubkey.");
  }

  if (TREASURY_WALLET.equals(PublicKey.default)) {
    throw new Error("Invalid TREASURY_WALLET: default pubkey.");
  }

  const initializerBalance = await connection.getBalance(initializer, "confirmed");

  console.log("Initializer SOL:", initializerBalance / LAMPORTS_PER_SOL);

  if (initializerBalance < 0.05 * LAMPORTS_PER_SOL) {
    throw new Error(
      [
        "Initializer balance is too low.",
        "主网初始化钱包需要有少量 SOL 支付交易费和 sale_state PDA rent。",
      ].join("\n")
    );
  }

  // ============================================================
  // 2. Derive PDAs
  // ============================================================

  printSection("2. Derive PDAs");

  const [saleStatePda, saleStateBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("sale_state")],
    PROGRAM_ID
  );

  const [mintAuthorityPda, mintAuthorityBump] =
    PublicKey.findProgramAddressSync(
      [Buffer.from("mint_authority")],
      PROGRAM_ID
    );

  console.log("sale_state PDA:", saleStatePda.toBase58());
  console.log("sale_state bump:", saleStateBump);
  console.log("mint_authority PDA:", mintAuthorityPda.toBase58());
  console.log("mint_authority bump:", mintAuthorityBump);

  // 根据你的源码和 Program ID，mint_authority PDA 应该是 Cjp5...
  const expectedMintAuthority = new PublicKey(
    "Cjp5gT5nErskpafYnY568huRacYzfCvvbjWA9TCsb4Ay"
  );

  if (!mintAuthorityPda.equals(expectedMintAuthority)) {
    throw new Error(
      [
        "Derived mint_authority PDA mismatch.",
        `Expected: ${expectedMintAuthority.toBase58()}`,
        `Actual:   ${mintAuthorityPda.toBase58()}`,
      ].join("\n")
    );
  }

  // ============================================================
  // 3. Check program account
  // ============================================================

  printSection("3. Check Program Account");

  const programInfo = await connection.getAccountInfo(PROGRAM_ID, "confirmed");

  if (!programInfo) {
    throw new Error(
      `Program not found on mainnet: ${PROGRAM_ID.toBase58()}`
    );
  }

  if (!programInfo.executable) {
    throw new Error("Program account exists but is not executable.");
  }

  console.log("Program exists:", true);
  console.log("Program owner:", programInfo.owner.toBase58());
  console.log("Program executable:", programInfo.executable);
  console.log("Program lamports:", programInfo.lamports);

  // ============================================================
  // 4. Check sale_state
  // ============================================================

  printSection("4. Check Existing sale_state");

  const saleStateInfo = await connection.getAccountInfo(
    saleStatePda,
    "confirmed"
  );

  if (saleStateInfo && saleStateInfo.data.length > 0) {
    console.log("sale_state already exists.");

    const state = await program.account.saleState.fetch(saleStatePda);

    console.log("initializer:", state.initializer.toBase58());
    console.log("gnumer_mint:", state.gnumerMint.toBase58());
    console.log("mint_authority:", state.mintAuthority.toBase58());
    console.log("treasury_wallet:", state.treasuryWallet.toBase58());
    console.log("total_raised_lamports:", state.totalRaisedLamports.toString());
    console.log("treasury_balance_lamports:", state.treasuryBalanceLamports.toString());
    console.log("total_spent_lamports:", state.totalSpentLamports.toString());
    console.log("is_closed:", state.isClosed);
    console.log("mint_authority_revoked:", state.mintAuthorityRevoked);
    console.log("sale_state_closed:", state.saleStateClosed);

    throw new Error("sale_state 已经初始化，不能重复 initialize。");
  }

  if (saleStateInfo && saleStateInfo.data.length === 0) {
    console.log("sale_state exists but data length is 0. It may be closed.");
  } else {
    console.log("sale_state does not exist. Ready to initialize.");
  }

  // ============================================================
  // 5. Check Token-2022 mint
  // ============================================================

  printSection("5. Check Token-2022 Mint");

  const mintAccountInfo = await connection.getAccountInfo(
    GNUMER_MINT,
    "confirmed"
  );

  if (!mintAccountInfo) {
    throw new Error(`GNUMER mint not found: ${GNUMER_MINT.toBase58()}`);
  }

  console.log("Mint account owner:", mintAccountInfo.owner.toBase58());

  if (!mintAccountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error(
      [
        "GNUMER mint is not owned by Token-2022 program.",
        `Expected owner: ${TOKEN_2022_PROGRAM_ID.toBase58()}`,
        `Actual owner:   ${mintAccountInfo.owner.toBase58()}`,
      ].join("\n")
    );
  }

  const mintInfo = await getMint(
    connection,
    GNUMER_MINT,
    "confirmed",
    TOKEN_2022_PROGRAM_ID
  );

  console.log("mint decimals:", mintInfo.decimals);
  console.log("mint supply base units:", mintInfo.supply.toString());
  console.log("mint supply UI:", Number(mintInfo.supply) / 1_000_000_000);
  console.log(
    "mint authority:",
    mintInfo.mintAuthority ? mintInfo.mintAuthority.toBase58() : "null"
  );
  console.log(
    "freeze authority:",
    mintInfo.freezeAuthority ? mintInfo.freezeAuthority.toBase58() : "null"
  );

  if (mintInfo.decimals !== TOKEN_DECIMALS) {
    throw new Error(
      [
        "Invalid mint decimals.",
        `Expected: ${TOKEN_DECIMALS}`,
        `Actual:   ${mintInfo.decimals}`,
      ].join("\n")
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
        "",
        "必须先把 Token-2022 mint authority 转给合约 PDA。",
      ].join("\n")
    );
  }

  if (mintInfo.freezeAuthority !== null) {
    throw new Error(
      [
        "Invalid freeze authority.",
        "源码要求 freeze authority 必须为 null。",
        `Actual: ${mintInfo.freezeAuthority.toBase58()}`,
      ].join("\n")
    );
  }

  // ============================================================
  // 6. Check treasury
  // ============================================================

  printSection("6. Check Treasury Wallet");

  const treasuryInfo = await connection.getAccountInfo(
    TREASURY_WALLET,
    "confirmed"
  );

  if (!treasuryInfo) {
    console.log("Treasury account does not exist yet.");
    console.log("System wallet 首次接收 SOL 时也可以存在；但主网建议先转少量 SOL 激活。");
  } else {
    console.log("treasury owner:", treasuryInfo.owner.toBase58());
    console.log("treasury lamports:", treasuryInfo.lamports);
    console.log("treasury SOL:", treasuryInfo.lamports / LAMPORTS_PER_SOL);
    console.log("treasury data length:", treasuryInfo.data.length);
  }

  // ============================================================
  // 7. Send initialize
  // ============================================================

  printSection("7. Send initialize Transaction");

  const txSig = await program.methods
    .initialize(TREASURY_WALLET)
    .accounts({
      saleState: saleStatePda,
      initializer,
      mintAuthority: mintAuthorityPda,
      gnumerMint: GNUMER_MINT,
      systemProgram: SystemProgram.programId,
    } as any)
    .rpc();

  console.log("initialize tx:", txSig);
  console.log("Explorer:", `https://explorer.solana.com/tx/${txSig}`);

  // ============================================================
  // 8. Read sale_state after initialize
  // ============================================================

  printSection("8. Read sale_state After Initialize");

  const state = await program.account.saleState.fetch(saleStatePda);

  console.log("sale_state:", saleStatePda.toBase58());
  console.log("initializer:", state.initializer.toBase58());
  console.log("gnumer_mint:", state.gnumerMint.toBase58());
  console.log("mint_authority:", state.mintAuthority.toBase58());
  console.log("treasury_wallet:", state.treasuryWallet.toBase58());

  console.log("total_raised_lamports:", state.totalRaisedLamports.toString());
  console.log("treasury_balance_lamports:", state.treasuryBalanceLamports.toString());
  console.log("total_spent_lamports:", state.totalSpentLamports.toString());

  console.log("is_closed:", state.isClosed);
  console.log("mint_authority_revoked:", state.mintAuthorityRevoked);
  console.log("sale_state_closed:", state.saleStateClosed);

  console.log("state_bump:", state.stateBump);
  console.log("mint_authority_bump:", state.mintAuthorityBump);

  // ============================================================
  // 9. Final verification
  // ============================================================

  printSection("9. Final Verification");

  if (!state.initializer.equals(initializer)) {
    throw new Error("Final check failed: initializer mismatch.");
  }

  if (!state.gnumerMint.equals(GNUMER_MINT)) {
    throw new Error("Final check failed: gnumer_mint mismatch.");
  }

  if (!state.mintAuthority.equals(mintAuthorityPda)) {
    throw new Error("Final check failed: mint_authority mismatch.");
  }

  if (!state.treasuryWallet.equals(TREASURY_WALLET)) {
    throw new Error("Final check failed: treasury_wallet mismatch.");
  }

  if (!state.totalRaisedLamports.isZero()) {
    throw new Error("Final check failed: total_raised_lamports should be zero.");
  }

  if (state.isClosed !== false) {
    throw new Error("Final check failed: is_closed should be false.");
  }

  if (state.mintAuthorityRevoked !== false) {
    throw new Error("Final check failed: mint_authority_revoked should be false.");
  }

  if (state.saleStateClosed !== false) {
    throw new Error("Final check failed: sale_state_closed should be false.");
  }

  console.log("All final checks passed.");

  console.log("");
  console.log("========================================");
  console.log("Initialize Completed Successfully");
  console.log("========================================");
  console.log("Program ID:", PROGRAM_ID.toBase58());
  console.log("sale_state:", saleStatePda.toBase58());
  console.log("mint_authority:", mintAuthorityPda.toBase58());
  console.log("gnumer_mint:", GNUMER_MINT.toBase58());
  console.log("treasury_wallet:", TREASURY_WALLET.toBase58());
}

main().catch((err) => {
  console.error("");
  console.error("========================================");
  console.error("Initialize Failed");
  console.error("========================================");
  console.error(err);
  process.exit(1);
});
