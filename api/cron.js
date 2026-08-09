const { initializeApp } = require('firebase/app');
const { getFirestore, collection, getDocs, doc, setDoc } = require('firebase/firestore');
const { Connection, Keypair, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');

// Config Firebase kamu
const firebaseConfig = {
    apiKey: "AIzaSyBR8qJlgHz3M44QJw6557W5YBUS0MTE-XU",
    projectId: "terminal-sniper-db",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async function (req, res) {
    try {
        // Looping 12 kali x 5 detik = 60 detik (1 Menit)
        for (let cycle = 0; cycle < 12; cycle++) {
            console.log(`Cek harga siklus ke-${cycle + 1}...`);
            
            const usersSnap = await getDocs(collection(db, 'users'));
            for (const userDoc of usersSnap.docs) {
                const userId = userDoc.id;
                const historySnap = await getDocs(collection(db, 'users', userId, 'history'));
                const configSnap = await getDocs(collection(db, 'users', userId, 'config'));
                const userConfig = configSnap.empty ? {} : configSnap.docs[0].data();

                for (const hDoc of historySnap.docs) {
                    const item = hDoc.data();
                    const pos = item.position;
                    
                    if (pos && pos.solAmount > 0 && pos.tpSl) {
                        const tp = Number(pos.tpSl.tp) || 0;
                        const sl = Number(pos.tpSl.sl) || 0;
                        
                        if (tp > 0 || sl > 0) {
                            try {
                                const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${item.mint}`);
                                const dexData = await dexRes.json();
                                const currentMcap = dexData.pairs?.[0]?.fdv || 0;
                                const entryMcap = pos.entryMcap || 1;
                                const pnlPct = ((currentMcap - entryMcap) / entryMcap) * 100;

                                if ((tp > 0 && pnlPct >= tp) || (sl > 0 && pnlPct <= -sl)) {
                                    console.log(`TRIGGER! Token ${item.symbol} kena TP/SL: ${pnlPct}%`);
                                    
                                    // 1. EKSEKUSI REAL JUPITER (Jika ada Private Key)
                                    if (userConfig.privateKey && userConfig.privateKey.length > 30) {
                                        try {
                                            const conn = new Connection("https://api.mainnet-beta.solana.com");
                                            const wallet = Keypair.fromSecretKey(bs58.decode(userConfig.privateKey));
                                            
                                            // Asumsi desimal token = 6. Hitung jumlah yang dijual
                                            const amountToSell = Math.floor(pos.tokenAmount * 1000000); 
                                            
                                            // Dapatkan rute Jupiter
                                            const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${item.mint}&outputMint=So11111111111111111111111111111111111111112&amount=${amountToSell}&slippageBps=1500`;
                                            const quoteData = await (await fetch(quoteUrl)).json();
                                            
                                            // Eksekusi Swap
                                            const swapRes = await fetch('https://quote-api.jup.ag/v6/swap', {
                                                method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                body: JSON.stringify({ quoteResponse: quoteData, userPublicKey: wallet.publicKey.toString(), wrapAndUnwrapSol: true })
                                            });
                                            const swapData = await swapRes.json();
                                            const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
                                            const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
                                            transaction.sign([wallet]);
                                            await conn.sendRawTransaction(transaction.serialize());
                                            console.log("Real Jupiter swap success!");
                                        } catch(err) {
                                            console.log("Jupiter Swap error:", err.message);
                                        }
                                    }

                                    // 2. TUTUP POSISI DI DATABASE
                                    await setDoc(doc(db, 'users', userId, 'history', item.id), { ...item, position: null }, { merge: true });
                                    
                                    // 3. KIRIM NOTIFIKASI KE APLIKASI WEB
                                    const notifId = 'n-' + Date.now();
                                    await setDoc(doc(db, 'users', userId, 'notifications', notifId), {
                                        id: notifId,
                                        message: `🤖 Auto TP/SL Dieksekusi: $${item.symbol}`,
                                        subtext: `Target tercapai di PnL: ${pnlPct.toFixed(1)}%`,
                                        type: pnlPct > 0 ? 'success' : 'error',
                                        timestamp: Date.now(),
                                        read: false
                                    });
                                }
                            } catch(e) {}
                        }
                    }
                }
            }
            // Tunggu 5 detik sebelum cek harga lagi
            if (cycle < 11) await sleep(5000); 
        }

        res.status(200).json({ status: "Selesai", message: "12 Siklus pengecekan (tiap 5s) rampung." });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};
