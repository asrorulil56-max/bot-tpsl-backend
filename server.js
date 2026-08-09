const express = require('express');
const { initializeApp } = require('firebase/app');
const { getAuth, signInWithEmailAndPassword } = require('firebase/auth');
const { getFirestore, collection, doc, setDoc, onSnapshot } = require('firebase/firestore');
const solanaWeb3 = require('@solana/web3.js');
const bs58 = require('bs58'); 

// ==========================================
// ⚙️ KONFIGURASI BOT (UBAH BAGIAN INI)
// ==========================================
const BOT_ID = "moyasama"; 
const BOT_PASSWORD = "moyasama";

const firebaseConfig = {
    apiKey: "AIzaSyBR8qJlgHz3M44QJw6557W5YBUS0MTE-XU",
    authDomain: "terminal-sniper-db.firebaseapp.com",
    projectId: "terminal-sniper-db",
    storageBucket: "terminal-sniper-db.firebasestorage.app",
    messagingSenderId: "257721706511",
    appId: "1:257721706511:web:de0a4cbf03af319c405b7a"
};
// ==========================================

const app = express();
const port = process.env.PORT || 3000;

// Ini halaman web kecil agar UptimeRobot bisa memonitor bot
app.get('/', (req, res) => res.send('🟢 Bot Terminal Sniper Render Aktif 24/7!'));
app.listen(port, () => console.log(`Server nyala di port ${port}`));

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);
const connection = new solanaWeb3.Connection("https://api.mainnet-beta.solana.com", 'confirmed');

let userId = null;
let tradeConfig = null;
let historyList = [];

async function executeSell(item, currentMcap, triggerType) {
    console.log(`[EKSEKUSI] ⚡ ${triggerType} tersentuh untuk ${item.symbol}!`);
    
    if (!tradeConfig || !tradeConfig.privateKey) {
        console.log(`⚠️ Mode Simulasi: Transaksi ${item.symbol} terjual.`);
        closePositionInDB(item, currentMcap, triggerType);
        return;
    }

    try {
        console.log(`🔄 Real Swap untuk ${item.symbol}...`);
        const wallet = solanaWeb3.Keypair.fromSecretKey(bs58.decode(tradeConfig.privateKey));
        const tokenMint = new solanaWeb3.PublicKey(item.mint);
        
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: tokenMint });
        if (!tokenAccounts.value || tokenAccounts.value.length === 0) throw new Error("Saldo token kosong.");
        const exactAmountStr = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount; 

        const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${item.mint}&outputMint=So11111111111111111111111111111111111111112&amount=${exactAmountStr}&slippageBps=${(tradeConfig.slippage || 15) * 100}`;
        const quoteRes = await fetch(quoteUrl);
        const quoteData = await quoteRes.json();

        const swapRes = await fetch('https://quote-api.jup.ag/v6/swap', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ quoteResponse: quoteData, userPublicKey: wallet.publicKey.toString(), wrapAndUnwrapSol: true })
        });
        const swapData = await swapRes.json();
        
        const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
        const transaction = solanaWeb3.VersionedTransaction.deserialize(swapTransactionBuf);
        transaction.sign([wallet]);
        
        const txid = await connection.sendRawTransaction(transaction.serialize());
        console.log(`✅ JUAL SUKSES! TX: ${txid}`);
        closePositionInDB(item, currentMcap, triggerType);
    } catch (err) {
        console.error(`❌ Gagal jual ${item.symbol}:`, err.message);
    }
}

async function closePositionInDB(item, currentMcap, triggerType) {
    try {
        const updatedItem = { ...item, position: null };
        await setDoc(doc(db, 'users', userId, 'history', item.id), updatedItem);
        const ledgerId = `id-${Date.now()}`;
        const newLedger = { id: ledgerId, type: triggerType, mint: item.mint, symbol: item.symbol, entryMcap: item.position.entryMcap, exitMcap: currentMcap, mode: 'BOT_AUTO', timestamp: Date.now() };
        await setDoc(doc(db, 'users', userId, 'ledger', ledgerId), newLedger);
    } catch (e) {
        console.error("Gagal update DB:", e);
    }
}

async function botLoop() {
    if (!userId || historyList.length === 0) return;
    const mints = historyList.filter(h => h.position && h.position.solAmount > 0).map(h => h.mint);
    if (mints.length === 0) return;

    try {
        const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mints.join(',')}`);
        const data = await res.json();
        if (!data || !data.pairs) return;

        for (const item of historyList) {
            if (!item.position || item.position.solAmount <= 0) continue;
            const pair = data.pairs.find(p => p.baseToken.address === item.mint);
            if (!pair) continue;

            const currentMcap = pair.fdv || 0;
            const entryMcap = item.position.entryMcap || 1;
            const pnlPct = ((currentMcap - entryMcap) / entryMcap) * 100;

            const tpSl = item.position.tpSl || { tp: 0, sl: 0 };
            const tpLimit = Number(tpSl.tp) || 0;
            const slLimit = -(Number(tpSl.sl) || 0);

            if (tpLimit > 0 && pnlPct >= tpLimit) await executeSell(item, currentMcap, 'TAKE PROFIT (TP)');
            else if (slLimit < 0 && pnlPct <= slLimit) await executeSell(item, currentMcap, 'STOP LOSS (SL)');
        }
    } catch (error) {}
}

async function startBot() {
    try {
        const fakeEmail = `${BOT_ID.trim().toLowerCase()}@terminalsniper.app`;
        const userCredential = await signInWithEmailAndPassword(auth, fakeEmail, BOT_PASSWORD);
        userId = userCredential.user.uid;
        console.log("✅ Login berhasil! Bot terhubung.");

        onSnapshot(doc(db, 'users', userId, 'config', 'main'), (doc) => { if (doc.exists()) tradeConfig = doc.data(); });
        onSnapshot(collection(db, 'users', userId, 'history'), (snapshot) => {
            historyList = [];
            snapshot.forEach(doc => historyList.push(doc.data()));
        });

        setInterval(botLoop, 10000); // Loop setiap 10 detik
        console.log("🚀 Scanner TP/SL berjalan di Render...");
    } catch (error) {
        console.error("❌ Login gagal. Cek ID & Password.");
    }
}
startBot();
 
