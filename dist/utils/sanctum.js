import { Transaction } from "@solana/web3.js";
export class SanctumGateway {
    apiKey;
    endpoint;
    fallbackConnection;
    constructor(config) {
        this.apiKey = config.apiKey;
        // Use /v1/ for delivery endpoints
        this.endpoint = `https://tpg.sanctum.so/v1/${config.cluster}?apiKey=${config.apiKey}`;
        this.fallbackConnection = config.fallbackConnection;
    }
    /**
     * Build and optimize transaction through Sanctum Gateway
     * This adds proper priority fees, tips, and optimizations automatically
     */
    async buildGatewayTransaction(transaction) {
        try {
            const serialized = transaction.serialize({
                requireAllSignatures: false,
                verifySignatures: false
            });
            const base64Tx = serialized.toString('base64');
            console.log('🔧 Building transaction via Sanctum Gateway...');
            const response = await fetch(this.endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: `build-${Date.now()}`,
                    method: 'buildGatewayTransaction',
                    params: [
                        base64Tx,
                        {
                            encoding: 'base64',
                            // Let Sanctum handle optimization
                            // It will add tips, priority fees, etc. automatically
                        }
                    ]
                })
            });
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Sanctum buildGatewayTransaction error: ${response.status} - ${errorText}`);
            }
            const result = await response.json();
            if (result.error) {
                throw new Error(`Sanctum build error: ${result.error.message || JSON.stringify(result.error)}`);
            }
            if (!result.result?.transaction) {
                throw new Error('No transaction returned from buildGatewayTransaction');
            }
            console.log('✅ Transaction optimized by Sanctum Gateway');
            return result.result.transaction; // Returns optimized base64 transaction
        }
        catch (error) {
            console.error('❌ Sanctum build failed:', error);
            throw error;
        }
    }
    /**
     * Submit an ALREADY SIGNED transaction via Sanctum
     * Transaction should already be optimized by buildGatewayTransaction
     */
    async submitTransaction(signedTransaction) {
        try {
            const serialized = signedTransaction.serialize();
            const base64Tx = serialized.toString('base64');
            console.log('📤 Submitting signed transaction via Sanctum Gateway...');
            const response = await fetch(this.endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: `tx-${Date.now()}`,
                    method: 'sendTransaction',
                    params: [
                        base64Tx,
                        {
                            encoding: 'base64',
                        }
                    ]
                })
            });
            if (!response.ok) {
                const errorText = await response.text();
                console.error(`Sanctum HTTP error ${response.status}:`, errorText);
                throw new Error(`Sanctum API error: ${response.status} - ${errorText}`);
            }
            const result = await response.json();
            if (result.error) {
                console.error('Sanctum RPC error:', result.error);
                throw new Error(`Sanctum error: ${result.error.message || JSON.stringify(result.error)}`);
            }
            if (!result.result) {
                throw new Error('No signature returned from Sanctum');
            }
            console.log(`✅ Transaction sent via Sanctum: ${result.result}`);
            return result.result;
        }
        catch (error) {
            console.error('❌ Sanctum submission failed:', error);
            // Try fallback if available
            if (this.fallbackConnection) {
                console.log('🔄 Falling back to standard RPC...');
                const signature = await this.fallbackConnection.sendRawTransaction(signedTransaction.serialize(), {
                    skipPreflight: false,
                    preflightCommitment: 'confirmed',
                    maxRetries: 3
                });
                console.log(`✅ Transaction sent via standard delivery: ${signature}`);
                return signature;
            }
            throw error;
        }
    }
    /**
     * Complete flow: Build, sign, and submit
     * This is what should be used for Sanctum priority delivery
     */
    async buildSignAndSubmit(unsignedTransaction, signFunction) {
        try {
            // Step 1: Let Sanctum optimize the transaction
            const optimizedBase64 = await this.buildGatewayTransaction(unsignedTransaction);
            // Step 2: Deserialize the optimized transaction
            const optimizedTx = Transaction.from(Buffer.from(optimizedBase64, 'base64'));
            // Step 3: Sign it
            console.log('✍️ Signing optimized transaction...');
            const signedTx = await signFunction(optimizedTx);
            // Step 4: Submit it
            return await this.submitTransaction(signedTx);
        }
        catch (error) {
            console.error('❌ Sanctum build-sign-submit flow failed:', error);
            throw error;
        }
    }
}
// Singleton instance
let sanctumInstance = null;
export const getSanctumGateway = (connection) => {
    if (!sanctumInstance) {
        const apiKey = process.env.SANCTUM_API_KEY;
        if (!apiKey) {
            console.warn('⚠️ SANCTUM_API_KEY not set, priority delivery will not be available');
            throw new Error('SANCTUM_API_KEY not configured');
        }
        const cluster = connection?.rpcEndpoint?.includes('devnet') ? 'devnet' : 'mainnet';
        console.log(`🚀 Initializing Sanctum Gateway for ${cluster}`);
        sanctumInstance = new SanctumGateway({
            apiKey,
            cluster: cluster,
            fallbackConnection: connection
        });
    }
    return sanctumInstance;
};
