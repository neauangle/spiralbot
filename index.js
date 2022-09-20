import botiq from 'botiq';
import fs from 'fs';
import toml from 'toml';

const configs = toml.parse(fs.readFileSync('./config.tml', { 'encoding': 'utf-8' }));
const USER_CONFIG_SPIRAL_TO_USE = configs['spiral-to-use'];
const USER_CONFIG_USDC_TO_USE = configs['usdc-to-use'];
const USER_CONFIG_PING_INTERVAL_MS = configs['ping-interval-ms'];
const USER_CONFIG_NEGATIVE_SUPPLY_SELL_TRIGGER = configs['negative-supply-sell-trigger'];
const USER_CONFIG_NEGATIVE_SUPPLY_BUY_TRIGGER = configs['negative-supply-buy-trigger'];
const USER_CONFIG_PRICE_MIN_FALL_TRIGGER_PERCENT = configs['price-fall-percent-trigger'];
const USER_CONFIG_SLIPPAGE_PERCENT = configs['slippage-percent'];
const USER_CONFIG_PRIVATE_WALLET_KEY = configs['private-wallet-key'];
const JSON_RPC_ENDPOINT_URL = configs['json-rpc-endpoint-url'];


const spiralAddress = '0x6aedb157b9ca86e32200857aa2579d47098ace39';
const spiralDecimals = 9;


async function getNegativeSupplyRational(){
    const negativeSupplyBigNumber =  await ethereumEndpoint.generalContractCall({
        contractAddress: spiralAddress,
        abiFragment: 'function negativeSupply() external view returns (uint256)',
        functionArgs: [],
    });
    return botiq.util.makeRational(negativeSupplyBigNumber, spiralDecimals);
}


(async () => {
    const ethereumEndpoint = await botiq.ethers.createJsonRpcEndpoint({
        accessURL: JSON_RPC_ENDPOINT_URL,
        rateLimitPerSecond: 2,
    }); 
    const spiralTracker = await ethereumEndpoint.createTracker({
        exchange: botiq.ethers.chains.ethereum.exchanges.uniswapV2,
        tokenAddress: spiralAddress,
        comparatorAddress: botiq.ethers.chains.ethereum.tokenAddresses.USDC
    });

    const wallet = botiq.ethers.createWalletFromPrivateKey({
        privateKey: USER_CONFIG_PRIVATE_WALLET_KEY
    });

    let spiralToUse;
    if (USER_CONFIG_USDC_TO_USE){
        const buyResult = await botiq.ethers.UniswapV2.buyTokensWithExact({
            tracker: spiralTracker,
            privateKey: wallet.privateKey, 
            exactComparatorQuantity: USER_CONFIG_USDC_TO_USE, 
            slippagePercent: USER_CONFIG_SLIPPAGE_PERCENT
        });
        spiralToUse = buyResult.tokenQuantity.string;
    } else {
        spiralToUse = USER_CONFIG_SPIRAL_TO_USE;
    }
    if (!spiralToUse){
        throw Error("Must specify either 'spiral-to-use' or 'usdc-to-use' in config.tml");
    }


    console.log("Ready. Running bot...");
    while (true){
        console.log("Step 1: Add liquidity to keep spiral tokens in neutral charge...");
        //assumption: user has enough spiral and enough usdc to pair the spiral with
        //            NOTE: Botiq will reduce quantities to match usdc balance constraints
        const addLiquidityResult = await botiq.ethers.UniswapV2.addLiquidity({
            privateKey: wallet.privateKey, 
            tracker: spiralTracker, 
            tokenQuantity: spiralToUse, 
            slippagePercent: USER_CONFIG_SLIPPAGE_PERCENT
        });
        
        console.log("Step 2: Wait for negative supply to hit trigger...");
        while (true){
            const negativeSupplyRational = await getNegativeSupplyRational();
            console.log(`    Negative Supply: ${botiq.util.formatRational(negativeSupplyRational, 2)}`)
            if (negativeSupplyRational.greater(USER_CONFIG_NEGATIVE_SUPPLY_SELL_TRIGGER)){
                break;
            }
            await botiq.util.awaitMs(USER_CONFIG_PING_INTERVAL_MS);
        }
        
        console.log("Step 3: Remove liquidity...");
        const removeLiquidityResult = await botiq.ethers.UniswapV2.removeLiquidity({
            privateKey: wallet.privateKey, 
            tracker: spiralTracker,
            slippagePercent: USER_CONFIG_SLIPPAGE_PERCENT,
            pairQuantity: addLiquidityResult.pairQuantityReceived.string
        });

        console.log("Step 4: Sell spiral for usdc...");
        const sellResult = await  botiq.ethers.UniswapV2.sellExactTokens({
            tracker: spiralTracker,
            privateKey: wallet.privateKey, 
            exactTokenQuantity: removeLiquidityResult.tokenQuantityReceived.string, 
            slippagePercent: USER_CONFIG_SLIPPAGE_PERCENT
        });

        console.log("Step 5: Wait for negative supply to decrease and price to fall according to trigger settings...");
        const triggerPriceProportion = 1 - (USER_CONFIG_PRICE_MIN_FALL_TRIGGER_PERCENT / 100)
        const triggerPriceString = botiq.util.formatRational(sellResult.averageTokenPriceComparator.rational.multiply(triggerPriceProportion), spiralDecimals);
        while (true){
            const negativeSupplyRational = await getNegativeSupplyRational(); 
            if (negativeSupplyRational.lesser(USER_CONFIG_NEGATIVE_SUPPLY_BUY_TRIGGER)){
                const price = await spiralTracker.getNewPrice();
                if (botiq.makeRational(price).lesser(triggerPriceString)){
                    break;
                }
            }
            await botiq.util.awaitMs(USER_CONFIG_PING_INTERVAL_MS);
        }

        console.log("Step 6: Buy back spiral...");
        const buyResult = await botiq.ethers.UniswapV2.buyTokensWithExact({
            tracker: spiralTracker,
            privateKey: wallet.privateKey, 
            exactComparatorQuantity: sellResult.comparatorQuantity.string, 
            slippagePercent: USER_CONFIG_SLIPPAGE_PERCENT
        });
        
    }

})();

