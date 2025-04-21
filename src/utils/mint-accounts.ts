import { Connection } from "@solana/web3.js";

// export const connection = new Connection('https://devnet.helius-rpc.com/?api-key=460424af-54bf-4327-a17e-84620d95352b', 'confirmed');
export const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
export const tokenMintAccounts: { [key: string]: string } = {
  usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  abj: "ArPqn2d4q1BepXfQmWLbELMBMtQjyUiFMcTvQjDFT22i",
};
