import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from '@solana/spl-token';

// export const connection = new Connection('https://devnet.helius-rpc.com/?api-key=460424af-54bf-4327-a17e-84620d95352b', 'confirmed'); 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
// export const connection = new Connection('https://api.devnet.solana.com', 'confirmed');

export const connection = new Connection("https://mainnet.helius-rpc.com/?api-key=10b8f1fb-6b38-43cb-a769-e6965206020e")
// export const connection = new Connection("https://devnet.helius-rpc.com/?api-key=10b8f1fb-6b38-43cb-a769-e6965206020e")
export const tokenMintAccounts: { [key: string]: string } = {
  usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  abj: "ArPqn2d4q1BepXfQmWLbELMBMtQjyUiFMcTvQjDFT22i",
};


/**
 * Check if a user has a token account for a specific token and if it has a sufficient balance
 * @param connection Solana connection
 * @param walletAddress User's wallet address
 * @param tokenName Token name (e.g., 'usdc')
 * @param requiredAmount Amount needed for transaction
 * @returns Object with account existence and balance info
 */
export const checkTokenAccountBalance = async (
  connection: Connection,
  walletAddress: string,
  tokenName: string,
  requiredAmount: number
): Promise<{ exists: boolean; hasBalance: boolean; balance: number }> => {
  try {
    const wallet = new PublicKey(walletAddress);
    const tokenMintAddress = tokenMintAccounts[tokenName.toLowerCase()];
    
    if (!tokenMintAddress) {
      throw new Error(`Token ${tokenName} not supported.`);
    }
    
    const mintAddress = new PublicKey(tokenMintAddress);
    const tokenAccount = await getAssociatedTokenAddress(mintAddress, wallet);
    
    // Check if token account exists
    const tokenAccountInfo = await connection.getAccountInfo(tokenAccount);
    
    if (!tokenAccountInfo) {
      return { exists: false, hasBalance: false, balance: 0 };
    }
    
    // Get token balance
    const tokenBalance = await connection.getTokenAccountBalance(tokenAccount);
    const balance = Number(tokenBalance.value.amount) / Math.pow(10, tokenBalance.value.decimals);
    
    return {
      exists: true,
      hasBalance: balance >= requiredAmount,
      balance
    };
  } catch (error) {
    console.error("Error checking token account balance:", error);
    return { exists: false, hasBalance: false, balance: 0 };
  }
};

/**
 * Check if a user has enough SOL for transaction fees
 * @param connection Solana connection
 * @param walletAddress User's wallet address
 * @returns Object with SOL balance info
 */
export const checkSolBalance = async (
  connection: Connection,
  walletAddress: string
): Promise<{ hasBalance: boolean; balance: number }> => {
  try {
    const wallet = new PublicKey(walletAddress);
    const balance = await connection.getBalance(wallet);
    const solBalance = balance / 1e9; // Convert lamports to SOL
    
    // A typical transaction needs ~0.000005 SOL
    const minimumSolForFees = 0.000005;
    
    return {
      hasBalance: solBalance >= minimumSolForFees,
      balance: solBalance
    };
  } catch (error) {
    console.error("Error checking SOL balance:", error);
    return { hasBalance: false, balance: 0 };
  }
};