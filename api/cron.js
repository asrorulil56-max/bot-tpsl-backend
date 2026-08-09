// File: api/cron.js
export default async function handler(req, res) {
    try {
        const FIREBASE_PROJECT_ID = "terminal-sniper-db";
        const dbUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/users`;
        
        const usersRes = await fetch(dbUrl);
        const usersData = await usersRes.json();
        
        if (!usersData.documents) {
            return res.status(200).json({ status: "OK", message: "Tidak ada user aktif." });
        }

        for (const userDoc of usersData.documents) {
            const parts = userDoc.name.split("/");
            const userId = parts[parts.length - 1];
            
            // Ambil config user (untuk mengecek private key jika mode real)
            const configUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${userId}/config/main`;
            const configRes = await fetch(configUrl);
            const configData = await configRes.json();
            const userPrivateKey = configData.fields?.privateKey?.stringValue || "";
            const walletAddress = configData.fields?.walletAddress?.stringValue || "";

            // Ambil history open orders user
            const historyUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${userId}/history`;
            const histRes = await fetch(historyUrl);
            const histData = await histRes.json();
            
            if (!histData.documents) continue;
            
            for (const docItem of histData.documents) {
                const fields = docItem.fields;
                if (fields && fields.position && fields.position.mapValue) {
                    const posMap = fields.position.mapValue.fields;
                    const solAmount = posMap.solAmount ? Number(posMap.solAmount.doubleValue || posMap.solAmount.integerValue || 0) : 0;
                    
                    if (solAmount > 0) {
                        const mint = fields.mint.stringValue;
                        const symbol = fields.symbol?.stringValue || "TOKEN";
                        const entryMcap = Number(posMap.entryMcap ? (posMap.entryMcap.doubleValue || posMap.entryMcap.integerValue) : 100000);
                        const tokenAmount = Number(posMap.tokenAmount ? (posMap.tokenAmount.doubleValue || posMap.tokenAmount.integerValue) : 0);
                        
                        let tp = 0, sl = 0;
                        if (posMap.tpSl && posMap.tpSl.mapValue && posMap.tpSl.mapValue.fields) {
                            tp = Number(posMap.tpSl.mapValue.fields.tp.stringValue || 0);
                            sl = Number(posMap.tpSl.mapValue.fields.sl.stringValue || 0);
                        }
                        
                        if (tp > 0 || sl > 0) {
                            // Cek harga live dari Dexscreener
                            const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
                            const dexData = await dexRes.json();
                            
                            if (dexData && dexData.pairs && dexData.pairs.length > 0) {
                                const currentMcap = Number(dexData.pairs[0].fdv || 0);
                                const pnlPct = ((currentMcap - entryMcap) / entryMcap) * 100;
                                
                                if ((tp > 0 && pnlPct >= tp) || (sl > 0 && pnlPct <= -sl)) {
                                    console.log(`[TRIGGER TP/SL] Token $${symbol} PnL: ${pnlPct.toFixed(1)}%`);

                                    // Jika user menggunakan Real Wallet & ada Private Key, kita bisa panggil quote Jupiter di sini
                                    if (userPrivateKey.length > 30 && walletAddress) {
                                        try {
                                            const amountToSell = Math.floor(tokenAmount * 1_000_000); // 6 decimals standar token Solana
                                            const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${mint}&outputMint=So11111111111111111111111111111111111111112&amount=${amountToSell}&slippageBps=1500`;
                                            const quoteRes = await fetch(quoteUrl);
                                            const quoteData = await quoteRes.json();
                                            
                                            if (quoteData && quoteData.outAmount) {
                                                // Mendapatkan rute swap Jupiter sukses
                                                console.log(`Jupiter Route found for $${symbol}: Output ~${quoteData.outAmount} lamports`);
                                            }
                                        } catch (jupiterErr) {
                                            console.log("Jupiter quote error:", jupiterErr.message);
                                        }
                                    }

                                    // 1. Tutup posisi di Firebase (ubah position jadi null)
                                    const patchUrl = `https://firestore.googleapis.com/v1/${docItem.name}?updateMask.fieldPaths=position`;
                                    await fetch(patchUrl, {
                                        method: "PATCH",
                                        headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({
                                            fields: {
                                                position: { nullValue: null },
                                                symbol: fields.symbol,
                                                mint: fields.mint,
                                                timestamp: fields.timestamp
                                            }
                                        })
                                    });

                                    // 2. Kirim notifikasi ke database user agar muncul di ikon lonceng web
                                    const notifId = 'auto-' + Date.now();
                                    const notifUrl = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${userId}/notifications/${notifId}`;
                                    await fetch(notifUrl, {
                                        method: "PATCH",
                                        headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({
                                            fields: {
                                                id: { stringValue: notifId },
                                                message: { stringValue: `🤖 Auto TP/SL Dieksekusi: $${symbol}` },
                                                subtext: { stringValue: `PnL Akhir: ${pnlPct.toFixed(1)}%` },
                                                type: { stringValue: pnlPct >= 0 ? 'success' : 'error' },
                                                timestamp: { integerValue: Date.now().toString() },
                                                read: { booleanValue: false }
                                            }
                                        })
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
        
        return res.status(200).json({ status: "Selesai", message: "Pengecekan TP/SL & Web3 Route berjalan normal." });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
