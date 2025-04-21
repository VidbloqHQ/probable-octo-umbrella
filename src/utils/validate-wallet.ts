import { PublicKey } from "@solana/web3.js";

export const isValidWalletAddress = (walletAddress: string) => {
  try {
    const publicKey = new PublicKey(walletAddress);
    return PublicKey.isOnCurve(publicKey.toBuffer());
  } catch (e) {
    console.error("Invalid wallet address:", e);
    return false;
  }
};
