import { isValidWalletAddress } from "../utils/index.js";
import { trackQuery } from "../prisma.js";
import { cache } from "../redis.js";
// Token configurations
const TOKEN_CONFIGS = {
    usdc: {
        mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        decimals: 6,
        name: "USDC"
    },
    sol: {
        mint: "native",
        decimals: 9,
        name: "SOL"
    }
    // Add more tokens as needed
};
/**
 * Get token balances for a wallet address
 * Primary endpoint for SDK users
 */
export const getWalletBalance = async (req, res) => {
    const { walletAddress } = req.params;
    const { tokens = "usdc,sol", forceRefresh = false } = req.query;
    const tenant = req.tenant;
    let success = false;
    try {
        if (!tenant) {
            return res.status(401).json({ error: "Tenant authentication required." });
        }
        if (!walletAddress || !isValidWalletAddress(walletAddress)) {
            return res.status(400).json({ error: "Valid wallet address required." });
        }
        // Redis cache key
        const cacheKey = `balance:${tenant.id}:${walletAddress}:${tokens}`;
        // Check if forceRefresh is set to true (as string)
        const shouldUseCache = forceRefresh !== 'true';
        // Check Redis cache unless force refresh
        if (shouldUseCache) {
            try {
                const cached = await cache.get(cacheKey);
                if (cached) {
                    success = true;
                    res.setHeader('X-Cache', 'HIT');
                    res.setHeader('X-Balance-Source', 'cache');
                    return res.json({
                        ...cached,
                        cached: true
                    });
                }
            }
            catch (cacheError) {
                console.error("Redis cache read error:", cacheError);
                // Continue without cache
            }
        }
        else {
            console.log(`Force refresh requested for wallet: ${walletAddress}`);
        }
        res.setHeader('X-Cache', 'MISS');
        res.setHeader('X-Balance-Source', 'helius');
        // Parse requested tokens
        const requestedTokens = tokens.split(',').map(t => t.trim().toLowerCase());
        // Fetch from Helius API
        const heliusApiKey = process.env.HELIUS_API_KEY;
        if (!heliusApiKey) {
            throw new Error("Helius API key not configured");
        }
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        try {
            const heliusResponse = await fetch(`https://api.helius.xyz/v0/addresses/${walletAddress}/balances?api-key=${heliusApiKey}`, {
                headers: { "x-api-key": heliusApiKey },
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (!heliusResponse.ok) {
                // Log rate limit issues
                if (heliusResponse.status === 429) {
                    console.error("Helius rate limit reached");
                }
                throw new Error(`Helius API error: ${heliusResponse.status}`);
            }
            const heliusData = await heliusResponse.json();
            // Process balances for requested tokens
            const balances = {};
            // Get native SOL balance if requested
            if (requestedTokens.includes('sol')) {
                const solBalance = heliusData.nativeBalance / Math.pow(10, 9);
                balances.sol = {
                    amount: solBalance,
                    uiAmount: solBalance,
                    decimals: 9,
                    symbol: 'SOL'
                };
            }
            // Get token balances
            for (const tokenKey of requestedTokens) {
                if (tokenKey === 'sol')
                    continue; // Already handled
                const tokenConfig = TOKEN_CONFIGS[tokenKey];
                if (!tokenConfig) {
                    console.warn(`Unknown token requested: ${tokenKey}`);
                    continue;
                }
                const tokenData = heliusData.tokens?.find((t) => t.mint === tokenConfig.mint);
                const tokenBalance = tokenData ? tokenData.amount / Math.pow(10, tokenData.decimals) : 0;
                balances[tokenKey] = {
                    amount: tokenBalance,
                    uiAmount: tokenBalance,
                    decimals: tokenConfig.decimals,
                    symbol: tokenConfig.name,
                    mint: tokenConfig.mint
                };
            }
            // Prepare response
            const responseData = {
                balances,
                wallet: walletAddress,
                timestamp: Date.now(),
                cached: false
            };
            // ✅ FIXED: Only cache if NOT force refresh
            if (shouldUseCache) {
                try {
                    await cache.setWithTags(cacheKey, responseData, ['balance', `wallet:${walletAddress}`, `tenant:${tenant.id}`], 10 // 10 second TTL
                    );
                    console.log(`Cached balance for wallet: ${walletAddress}`);
                }
                catch (cacheError) {
                    console.error("Redis cache write error:", cacheError);
                    // Continue even if cache fails
                }
            }
            else {
                console.log(`Skipped caching (force refresh) for wallet: ${walletAddress}`);
            }
            success = true;
            return res.json(responseData);
        }
        catch (fetchError) {
            if (fetchError instanceof Error && fetchError.name === 'AbortError') {
                throw new Error('Helius API request timeout');
            }
            throw fetchError;
        }
    }
    catch (error) {
        console.error("Error fetching wallet balance:", error);
        // Try to return stale cache if available
        if (error instanceof Error && error.message.includes('Helius')) {
            try {
                const staleCache = await cache.get(`balance:${tenant?.id}:${walletAddress}:${tokens}`);
                if (staleCache) {
                    res.setHeader('X-Cache', 'STALE');
                    return res.json({
                        ...staleCache,
                        cached: true,
                        stale: true,
                        error: "Using cached data due to API error"
                    });
                }
            }
            catch (cacheError) {
                // Ignore cache errors
            }
        }
        return res.status(500).json({
            error: "Failed to fetch wallet balance",
            message: error instanceof Error ? error.message : "Unknown error"
        });
    }
    finally {
        trackQuery(success);
    }
};
/**
 * Batch get balances for multiple wallets
 * Useful for displaying multiple users' balances in UI
 */
export const getBatchBalances = async (req, res) => {
    const { wallets } = req.body;
    const { tokens = "usdc,sol" } = req.query;
    const tenant = req.tenant;
    let success = false;
    try {
        if (!tenant) {
            return res.status(401).json({ error: "Tenant authentication required." });
        }
        if (!wallets || !Array.isArray(wallets) || wallets.length === 0) {
            return res.status(400).json({
                error: "Wallets array is required"
            });
        }
        if (wallets.length > 20) {
            return res.status(400).json({
                error: "Maximum 20 wallets per request"
            });
        }
        // Check cache for each wallet first
        const results = [];
        const walletsToFetch = [];
        for (const wallet of wallets) {
            const cacheKey = `balance:${tenant.id}:${wallet}:${tokens}`;
            try {
                const cached = await cache.get(cacheKey);
                if (cached) {
                    results.push({
                        wallet,
                        ...cached,
                        cached: true
                    });
                }
                else {
                    walletsToFetch.push(wallet);
                }
            }
            catch (err) {
                walletsToFetch.push(wallet);
            }
        }
        // Fetch uncached wallets from Helius
        if (walletsToFetch.length > 0) {
            const heliusApiKey = process.env.HELIUS_API_KEY;
            if (!heliusApiKey) {
                throw new Error("Helius API key not configured");
            }
            const fetchPromises = walletsToFetch.map(async (wallet, index) => {
                // Add delay to avoid rate limits
                await new Promise(resolve => setTimeout(resolve, index * 100));
                try {
                    const response = await fetch(`https://api.helius.xyz/v0/addresses/${wallet}/balances?api-key=${heliusApiKey}`, {
                        headers: { "x-api-key": heliusApiKey },
                        signal: AbortSignal.timeout(5000)
                    });
                    if (!response.ok) {
                        throw new Error(`Failed to fetch balance for ${wallet}`);
                    }
                    const data = await response.json();
                    // Parse requested tokens
                    const requestedTokens = tokens.split(',').map(t => t.trim().toLowerCase());
                    const balances = {};
                    if (requestedTokens.includes('sol')) {
                        const solBalance = data.nativeBalance / Math.pow(10, 9);
                        balances.sol = {
                            amount: solBalance,
                            uiAmount: solBalance,
                            decimals: 9,
                            symbol: 'SOL'
                        };
                    }
                    for (const tokenKey of requestedTokens) {
                        if (tokenKey === 'sol')
                            continue;
                        const tokenConfig = TOKEN_CONFIGS[tokenKey];
                        if (!tokenConfig)
                            continue;
                        const tokenData = data.tokens?.find((t) => t.mint === tokenConfig.mint);
                        const tokenBalance = tokenData ? tokenData.amount / Math.pow(10, tokenData.decimals) : 0;
                        balances[tokenKey] = {
                            amount: tokenBalance,
                            uiAmount: tokenBalance,
                            decimals: tokenConfig.decimals,
                            symbol: tokenConfig.name,
                            mint: tokenConfig.mint
                        };
                    }
                    const result = {
                        wallet,
                        balances,
                        timestamp: Date.now(),
                        cached: false
                    };
                    // Cache the result
                    const cacheKey = `balance:${tenant.id}:${wallet}:${tokens}`;
                    await cache.setWithTags(cacheKey, result, ['balance', `wallet:${wallet}`, `tenant:${tenant.id}`], 10).catch(() => { }); // Ignore cache errors
                    return result;
                }
                catch (error) {
                    console.error(`Error fetching balance for ${wallet}:`, error);
                    return {
                        wallet,
                        error: "Failed to fetch balance",
                        cached: false
                    };
                }
            });
            const fetchResults = await Promise.allSettled(fetchPromises);
            for (const result of fetchResults) {
                if (result.status === 'fulfilled') {
                    results.push(result.value);
                }
            }
        }
        success = true;
        return res.json({
            balances: results,
            total: results.length,
            cached: walletsToFetch.length === 0
        });
    }
    catch (error) {
        console.error("Error fetching batch balances:", error);
        return res.status(500).json({
            error: "Failed to fetch batch balances"
        });
    }
    finally {
        trackQuery(success);
    }
};
/**
 * Force refresh balance cache for a wallet
 * Useful after transactions
 */
export const refreshWalletBalance = async (req, res) => {
    const { walletAddress } = req.params;
    const tenant = req.tenant;
    try {
        if (!tenant) {
            return res.status(401).json({ error: "Tenant authentication required." });
        }
        // Invalidate all balance cache for this wallet
        await cache.invalidateByTags([`wallet:${walletAddress}`]);
        // Force refresh by calling getWalletBalance with forceRefresh
        req.query.forceRefresh = 'true';
        return getWalletBalance(req, res);
    }
    catch (error) {
        console.error("Error refreshing wallet balance:", error);
        return res.status(500).json({
            error: "Failed to refresh wallet balance"
        });
    }
};
// import { Response } from "express";
// import { TenantRequest } from "../types/index.js";
// import { isValidWalletAddress } from "../utils/index.js";
// import { executeQuery, trackQuery, db } from "../prisma.js";
// import { cache } from "../redis.js";
// // Token configurations
// const TOKEN_CONFIGS = {
//   usdc: {
//     mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
//     decimals: 6,
//     name: "USDC"
//   },
//   sol: {
//     mint: "native",
//     decimals: 9,
//     name: "SOL"
//   }
//   // Add more tokens as needed
// };
// /**
//  * Get token balances for a wallet address
//  * Primary endpoint for SDK users
//  */
// export const getWalletBalance = async (req: TenantRequest, res: Response) => {
//   const { walletAddress } = req.params;
//   const { tokens = "usdc,sol", forceRefresh = false } = req.query;
//   const tenant = req.tenant;
//   let success = false;
//   try {
//     if (!tenant) {
//       return res.status(401).json({ error: "Tenant authentication required." });
//     }
//      if (!walletAddress || !isValidWalletAddress(walletAddress)) {
//           return res.status(400).json({ error: "Valid wallet address required." });
//         }
//     // Redis cache key
//     const cacheKey = `balance:${tenant.id}:${walletAddress}:${tokens}`;
//     // Check Redis cache unless force refresh
//     if (!forceRefresh && forceRefresh !== 'true') {
//       try {
//         const cached = await cache.get(cacheKey);
//         if (cached) {
//           success = true;
//           res.setHeader('X-Cache', 'HIT');
//           res.setHeader('X-Balance-Source', 'cache');
//           return res.json({
//             ...cached,
//             cached: true
//           });
//         }
//       } catch (cacheError) {
//         console.error("Redis cache read error:", cacheError);
//         // Continue without cache
//       }
//     }
//     res.setHeader('X-Cache', 'MISS');
//     res.setHeader('X-Balance-Source', 'helius');
//     // Parse requested tokens
//     const requestedTokens = (tokens as string).split(',').map(t => t.trim().toLowerCase());
//     // Fetch from Helius API
//     const heliusApiKey = process.env.HELIUS_API_KEY;
//     if (!heliusApiKey) {
//       throw new Error("Helius API key not configured");
//     }
//     const controller = new AbortController();
//     const timeoutId = setTimeout(() => controller.abort(), 5000);
//     try {
//       const heliusResponse = await fetch(
//         `https://api.helius.xyz/v0/addresses/${walletAddress}/balances?api-key=${heliusApiKey}`,
//         {
//           headers: { "x-api-key": heliusApiKey },
//           signal: controller.signal
//         }
//       );
//       clearTimeout(timeoutId);
//       if (!heliusResponse.ok) {
//         // Log rate limit issues
//         if (heliusResponse.status === 429) {
//           console.error("Helius rate limit reached");
//         }
//         throw new Error(`Helius API error: ${heliusResponse.status}`);
//       }
//       const heliusData = await heliusResponse.json();
//       // Process balances for requested tokens
//       const balances: Record<string, any> = {};
//       // Get native SOL balance if requested
//       if (requestedTokens.includes('sol')) {
//         const solBalance = heliusData.nativeBalance / Math.pow(10, 9);
//         balances.sol = {
//           amount: solBalance,
//           uiAmount: solBalance,
//           decimals: 9,
//           symbol: 'SOL'
//         };
//       }
//       // Get token balances
//       for (const tokenKey of requestedTokens) {
//         if (tokenKey === 'sol') continue; // Already handled
//         const tokenConfig = TOKEN_CONFIGS[tokenKey as keyof typeof TOKEN_CONFIGS];
//         if (!tokenConfig) {
//           console.warn(`Unknown token requested: ${tokenKey}`);
//           continue;
//         }
//         const tokenData = heliusData.tokens?.find((t: any) => t.mint === tokenConfig.mint);
//         const tokenBalance = tokenData ? tokenData.amount / Math.pow(10, tokenData.decimals) : 0;
//         balances[tokenKey] = {
//           amount: tokenBalance,
//           uiAmount: tokenBalance,
//           decimals: tokenConfig.decimals,
//           symbol: tokenConfig.name,
//           mint: tokenConfig.mint
//         };
//       }
//       // Prepare response
//       const responseData = {
//         balances,
//         wallet: walletAddress,
//         timestamp: Date.now(),
//         cached: false
//       };
//       // Cache in Redis with tags for invalidation
//       // Use 10 second TTL for balance data
//       try {
//         await cache.setWithTags(
//           cacheKey, 
//           responseData, 
//           ['balance', `wallet:${walletAddress}`, `tenant:${tenant.id}`],
//           10
//         );
//       } catch (cacheError) {
//         console.error("Redis cache write error:", cacheError);
//         // Continue even if cache fails
//       }
//       success = true;
//       return res.json(responseData);
//     } catch (fetchError) {
//       if (fetchError instanceof Error && fetchError.name === 'AbortError') {
//         throw new Error('Helius API request timeout');
//       }
//       throw fetchError;
//     }
//   } catch (error) {
//     console.error("Error fetching wallet balance:", error);
//     // Try to return stale cache if available
//     if (error instanceof Error && error.message.includes('Helius')) {
//       try {
//         const staleCache = await cache.get(`balance:${tenant?.id}:${walletAddress}:${tokens}`);
//         if (staleCache) {
//           res.setHeader('X-Cache', 'STALE');
//           return res.json({
//             ...staleCache,
//             cached: true,
//             stale: true,
//             error: "Using cached data due to API error"
//           });
//         }
//       } catch (cacheError) {
//         // Ignore cache errors
//       }
//     }
//     return res.status(500).json({ 
//       error: "Failed to fetch wallet balance",
//       message: error instanceof Error ? error.message : "Unknown error"
//     });
//   } finally {
//     trackQuery(success);
//   }
// };
// /**
//  * Batch get balances for multiple wallets
//  * Useful for displaying multiple users' balances in UI
//  */
// export const getBatchBalances = async (req: TenantRequest, res: Response) => {
//   const { wallets } = req.body;
//   const { tokens = "usdc,sol" } = req.query;
//   const tenant = req.tenant;
//   let success = false;
//   try {
//     if (!tenant) {
//       return res.status(401).json({ error: "Tenant authentication required." });
//     }
//     if (!wallets || !Array.isArray(wallets) || wallets.length === 0) {
//       return res.status(400).json({ 
//         error: "Wallets array is required" 
//       });
//     }
//     if (wallets.length > 20) {
//       return res.status(400).json({ 
//         error: "Maximum 20 wallets per request" 
//       });
//     }
//     // Check cache for each wallet first
//     const results = [];
//     const walletsToFetch = [];
//     for (const wallet of wallets) {
//       const cacheKey = `balance:${tenant.id}:${wallet}:${tokens}`;
//       try {
//         const cached = await cache.get(cacheKey);
//         if (cached) {
//           results.push({
//             wallet,
//             ...cached,
//             cached: true
//           });
//         } else {
//           walletsToFetch.push(wallet);
//         }
//       } catch (err) {
//         walletsToFetch.push(wallet);
//       }
//     }
//     // Fetch uncached wallets from Helius
//     if (walletsToFetch.length > 0) {
//       const heliusApiKey = process.env.HELIUS_API_KEY;
//       if (!heliusApiKey) {
//         throw new Error("Helius API key not configured");
//       }
//       const fetchPromises = walletsToFetch.map(async (wallet, index) => {
//         // Add delay to avoid rate limits
//         await new Promise(resolve => setTimeout(resolve, index * 100));
//         try {
//           const response = await fetch(
//             `https://api.helius.xyz/v0/addresses/${wallet}/balances?api-key=${heliusApiKey}`,
//             {
//               headers: { "x-api-key": heliusApiKey },
//               signal: AbortSignal.timeout(5000)
//             }
//           );
//           if (!response.ok) {
//             throw new Error(`Failed to fetch balance for ${wallet}`);
//           }
//           const data = await response.json();
//           // Parse requested tokens
//           const requestedTokens = (tokens as string).split(',').map(t => t.trim().toLowerCase());
//           const balances: Record<string, any> = {};
//           if (requestedTokens.includes('sol')) {
//             const solBalance = data.nativeBalance / Math.pow(10, 9);
//             balances.sol = {
//               amount: solBalance,
//               uiAmount: solBalance,
//               decimals: 9,
//               symbol: 'SOL'
//             };
//           }
//           for (const tokenKey of requestedTokens) {
//             if (tokenKey === 'sol') continue;
//             const tokenConfig = TOKEN_CONFIGS[tokenKey as keyof typeof TOKEN_CONFIGS];
//             if (!tokenConfig) continue;
//             const tokenData = data.tokens?.find((t: any) => t.mint === tokenConfig.mint);
//             const tokenBalance = tokenData ? tokenData.amount / Math.pow(10, tokenData.decimals) : 0;
//             balances[tokenKey] = {
//               amount: tokenBalance,
//               uiAmount: tokenBalance,
//               decimals: tokenConfig.decimals,
//               symbol: tokenConfig.name,
//               mint: tokenConfig.mint
//             };
//           }
//           const result = {
//             wallet,
//             balances,
//             timestamp: Date.now(),
//             cached: false
//           };
//           // Cache the result
//           const cacheKey = `balance:${tenant.id}:${wallet}:${tokens}`;
//           await cache.setWithTags(
//             cacheKey,
//             result,
//             ['balance', `wallet:${wallet}`, `tenant:${tenant.id}`],
//             10
//           ).catch(() => {}); // Ignore cache errors
//           return result;
//         } catch (error) {
//           console.error(`Error fetching balance for ${wallet}:`, error);
//           return {
//             wallet,
//             error: "Failed to fetch balance",
//             cached: false
//           };
//         }
//       });
//       const fetchResults = await Promise.allSettled(fetchPromises);
//       for (const result of fetchResults) {
//         if (result.status === 'fulfilled') {
//           results.push(result.value);
//         }
//       }
//     }
//     success = true;
//     return res.json({ 
//       balances: results,
//       total: results.length,
//       cached: walletsToFetch.length === 0
//     });
//   } catch (error) {
//     console.error("Error fetching batch balances:", error);
//     return res.status(500).json({ 
//       error: "Failed to fetch batch balances" 
//     });
//   } finally {
//     trackQuery(success);
//   }
// };
// /**
//  * Force refresh balance cache for a wallet
//  * Useful after transactions
//  */
// export const refreshWalletBalance = async (req: TenantRequest, res: Response) => {
//   const { walletAddress } = req.params;
//   const tenant = req.tenant;
//   try {
//     if (!tenant) {
//       return res.status(401).json({ error: "Tenant authentication required." });
//     }
//     // Invalidate all balance cache for this wallet
//     await cache.invalidateByTags([`wallet:${walletAddress}`]);
//     // Force refresh by calling getWalletBalance with forceRefresh
//     req.query.forceRefresh = 'true';
//     return getWalletBalance(req, res);
//   } catch (error) {
//     console.error("Error refreshing wallet balance:", error);
//     return res.status(500).json({ 
//       error: "Failed to refresh wallet balance" 
//     });
//   }
// };
