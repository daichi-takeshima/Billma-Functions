// CloudFunctionsを作成してトリガーを設定するためのFirebaseSDKのCloudFunctions。
const functions = require('firebase-functions');
const express = require('express');
const https = require('https');
const app = express()

// FirestoreにアクセスするためのFirebaseAdminSDK。
const admin = require('firebase-admin');
const { ResultStorage } = require('firebase-functions/lib/providers/testLab');
const { resolve } = require('path');
admin.initializeApp();

//レシート検証
//サンドボックスURL
const RECEIPT_VERIFICATION_ENDPOINT_FOR_IOS_SANDBOX = 'sandbox.itunes.apple.com/verifyReceipt';
//本番用URL
const RECEIPT_VERIFICATION_ENDPOINT_FOR_IOS_PROD = 'buy.itunes.apple.com/verifyReceipt';
//App用共用シークレット
const RECEIPT_VERIFICATION_PASSWORD_FOR_IOS = 'e5485ed17dd4411d9e6ca0e970a399d8';
//アプリID
const PACKAGE_NAME = 'jp.co.ACTN.BillmaApp';
//プロダクトID
const PRODUCT_ID = 'MonthlySubscription1'
//検証処理
exports.verifyEceptForIOS = functions.https.onCall(async (data, context) => {

    let result = {};
    var resultBody;
    const receiptData = data.data;
    const userID = data.userID;
    const restore = data.restore;
    const purchase = data.purchase;
    var oriTraID;

    const json = {
        "receipt-data": String(receiptData),
        "password": RECEIPT_VERIFICATION_PASSWORD_FOR_IOS,
        "exclude-old-transactions": true
    };
    const receiptString = JSON.stringify(json);

    //更新対象のuserIDがあるかどうかの判定
    if (userID == "userID == nil") {
        console.log('更新対象のuserIDなし')
        result.status = 403
        return result
    }

    //本番用検証
    await postReceipt(false, receiptString).then(async (resolve) => {

        if (!resolve) {
            //appStoreサーバーからの返却データなし
            console.log('bodyなし')
            result.status = 403
            return result
        } else {
            result.status = resolve.status;
            resultBody = resolve
            oriTraID = originalTransactionID()
            console.log('本番URL検証完了')
        }
    }).catch((error) => {
        //本番環境処理のエラー
        result.error = error;
        result.status = 400;
        return result
    })

    //サンドボックス検証
    if (resultBody.status == 21007) {
        await postReceipt(true, receiptString).then(async (resolve) => {
            if (!resolve) {
                //appStoreサーバーからの返却データなし
                console.log('bodyなし')
                result.status = 400
                return result
            } else {
                result.status = resolve.status;
                resultBody = resolve
                oriTraID = originalTransactionID()
                console.log('サンドボックスURL検証完了')
            }
        }).catch((error) => {
            //サンドボックス処理のエラー
            result.error = error;
            result.status = 400;
            return result
        })
    }

    //正しいステータスが返ってきたか確認
    if (resultBody.status != 0) {
        console.log(`ステータス0以外:status${resultBody.status}`)
        result.status = resultBody.status
        return result
    } else {
        console.log('ステータス確認通過')
    }
    //bundleID,Product_idが一致しているかの確認
    if (!resultBody.receipt || resultBody.receipt.bundle_id != PACKAGE_NAME) {
        console.log('バンドルIDが違うか無い')
        console.log(`バンドルID：${resultBody.receipt.bundle_id}`)
        result.status = 400
        return result
    } else {
        console.log('バンドルID確認通過')
    }

    const latestReceipt = resultBody.latest_receipt_info.slice(-1)[0]
    const productID = latestReceipt.product_id
    if (!productID || productID != PRODUCT_ID) {
        console.log('プロダクトIDが違うか無い')
        console.log(`プロダクトID：${productID}`)
        result.status = 403
        return result
    } else {
        console.log('プロダクトID通過')
    }
    //トランザクションの重複チェック
    const purchaseDataRef = admin.firestore().collection('Purchase').doc('transactionID')
    const purchaseData = await purchaseDataRef.get()
    const transactionIDArray = purchaseData.get('transactionIDArray')
    const transactionID = latestReceipt.transaction_id
    console.log(`transaction_ID: ${transactionID}`)

    if (!restore) {
        //通常の購入処理
        if (!transactionIDArray) {
            //取得に失敗
            console.log('トランザクションID配列の取得に失敗')
            result.status = 403
            return result
        } else {
            //トランザクション配列の重複チェック
            console.log('通常の購入、トランザクションIDの重複チェック')
            if (transactionIDArray.includes(transactionID)) {
                //トランザクションIDの重複
                console.log('トランザクションの重複')
                result.status = 403
                return result
            } else {
                //トランザクションの重複なし、トランザクションを保存
                console.log('トランザクション重複なし')
                addTransactionID(transactionID)
            }
        }
    } else {
        //サブスクを別アカウントへ移行
        console.log('restore処理、トランザクションIDの重複チェックなし')
    }
    //レシート検証が正常に完了した処理
    result.status = 200;
    result.message = 'レシート検証成功';
    //result.receiptCollections = receiptCollections
    resultBody.receipt = resultBody.receipt;
    console.log('レシート検証成功')
    return updatePurchase(200)

    //関数
    //appStoreへhttps.requestでレシート情報を投げる
    function postReceipt(sandBox, verificationString) {
        return new Promise((resolve, reject) => {
            const host = sandBox ? "sandbox.itunes.apple.com" : "buy.itunes.apple.com"
            const options = {
                host: host,
                path: "/verifyReceipt",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(verificationString),
                },
                method: "POST",
                json: true
            };
            const request = https.request(options, (response) => {
                console.log('requestStart!')
                const body = [];
                response.on("data", (chunk) => {
                    body.push(chunk);
                }).on("end", () => {
                    resolve(JSON.parse(Buffer.concat(body)));
                }).on("error", (error) => {
                    console.log('appStoreエラー')
                    reject(error);
                });
            });
            request.write(verificationString)
            request.end()
        })
    }

    //トランザクションIDの保存
    function addTransactionID(transactionID) {
        const transactionsRef = admin.firestore().collection('Purchase').doc('transactionID')
        console.log(`トランザクション一覧に追加:${transactionID}`)
        transactionsRef.update({transactionIDArray:admin.firestore.FieldValue.arrayUnion(transactionID)})
    }

    function originalTransactionID() {
        const receipt = resultBody.receipt.in_app.slice(-1)[0]
        const originalTransactionID = receipt.original_transaction_id
        return originalTransactionID
    }

    //DBにレシート情報を保存
    function updatePurchase(status) {
        ////////////////変更////////////////
        //レシート配列を確認するためにレシートごとに日付を書き出し
        (async function() {
            for (const receipt of resultBody.latest_receipt_info) {
                const expiresDate = receipt.expires_date.substr(0,17)
                console.log(`レシートごとの更新日書き出し：${expiresDate}`)
            }
            const receipt = resultBody.latest_receipt_info.slice(-1)[0]
            const transaction_id = receipt.transaction_id
            const expiresDateStr = receipt.expires_date.substr(0,17)
            const expiresDate = new Date(expiresDateStr)
            const updateData = {
                expiresDate: expiresDate,
                original_transactionID: oriTraID,
                transaction_id: transaction_id,
                receipt: receipt
            }
            console.log(`expiresDate(verifyEceptForIOS): ${expiresDateStr}`)
            //ユーザーデータに支払い情報を保存
            const ref = admin.firestore().collection('Purchase').doc('subscriptionUser');
            const documentSnapshot = await ref.get();
            var targetUserID
            var beforeID
            if (documentSnapshot) {
                const data = documentSnapshot.data();
                const beforeUserID = data[oriTraID];
                beforeID = String(beforeUserID)
            }
            console.log(`購入判定：${purchase},リストア判定：${restore}`)
            if (status == 200) {//検証成功、firestoreに支払いデータを保存する
                if (beforeID || beforeID != 'undefined') {
                    if (purchase || restore) {
                        console.log('購入またはリストア')
                        //購入処理時(ログイン中のIDを保存先にする)
                        targetUserID = userID
                        //アカウント切り替わりの場合は前のアカウントからexpiresDateを削除
                        if (beforeID != userID) {//アカウントが切り替わっているので古い方を削除
                            console.log('購入またはリストア：サブスク対象切り替わり')
                            admin.firestore().collection(beforeID).doc(beforeID).update({
                                expiresDate: admin.firestore.FieldValue.delete()
                            })
                        }
                    } else {
                        console.log('購入またはリストア以外の処理')
                        //購入以外でトランザクションが飛んできた時の処理(従来通りの保存先)
                        targetUserID = beforeID
                    }
                } else {
                    console.log('beforeIDなし')
                    targetUserID = userID
                }
                console.log(`ユーザーデータを更新,targetID：${targetUserID},beforeID:${beforeID}`)
                admin.firestore().collection(targetUserID).doc(targetUserID).update(updateData)
            } else {
                //検証失敗、firestoreに支払いデータを保存する
                //admin.firestore().collection(userID).doc(userID).update(updateData)
                console.log('検証失敗')
                result.status = 403
                return result
            }
            //サブスクユーザー一覧に保存
            console.log('サブスクユーザー一覧を更新')
            const IDCombination = {}
            IDCombination[oriTraID] = targetUserID
            admin.firestore().collection('Purchase').doc('subscriptionUser').update(IDCombination)
            result.status = 200
            return result
        })()
    }

});

//AppStoreからサブスクステータスの更新を受け取ってDBを更新する
exports.updateSubscriptionStatus = functions.https.onRequest((req, res) => {
    //
    const body = req.body;
    const receipt = body.unified_receipt.latest_receipt_info[0];
    const originalTransactionID = receipt.original_transaction_id;
    const transaction_id = receipt.transaction_id
    const notificationType = body.notification_type;
    const expiresDateStr = receipt.expires_date.substr(0,17)
    const expiresDate = new Date(expiresDateStr);
    
    /*サーバー通知の全てを出力
    Object.keys(body).forEach(function(key) {
        console.log(`${key} : ${body[key]}`)
    })*/
    /*
    Object.keys(receipt).forEach(function(key) {
        console.log(`${key} : ${receipt[key]}`)
    })*/

    (async function () {
        const ref = admin.firestore().collection('Purchase').doc('subscriptionUser');
        const documentSnapshot = await ref.get();
        if (!documentSnapshot) {
            console.log('DBからデータ取得失敗');
            res.status(403).send('status:403');
        } else {
            const data = documentSnapshot.data();
            const userID = data[originalTransactionID];
            console.log(`targetUserID:${userID}`);
            updateUserStatus(userID);
            res.status(200).send('status:200');
        }
    })()

    //ステータス更新対象ユーザーを更新する
    function updateUserStatus(userID) {
        if (!userID) {
            console.log('サブスクリプションユーザーの一覧取得に失敗')
        } else {
            console.log('サブスクリプションユーザーの一覧取得成功')
            //更新対象のUserID
            const userRef = admin.firestore().collection(userID).doc(userID)
            console.log(`notificationType: ${notificationType}`)
            userRef.update({
                receipt: receipt,
                expiresDate: expiresDate,
                transaction_id : transaction_id
            })
            console.log(`expiresDate(updateStatus):${expiresDateStr}`)
        }
    }
})
/*メモ
トランザクションIDの重複チェック
1. ●DBに本尊してあるトランザクションIDデータを取得
2. ●データを文字列配列に変換
3. ●今回取得してきたレシートのトランザクションIDが配列に含まれているか確認する
4. ●含まれていれば不正なので処理を終了してエラーを返す
　　●含まれていなければ正しいレシートなのでIDを保存して処理を継続する
*/

/*メモ
userDataに有料機能の使用可否を記録
*/

/*メモ
AppStoreサーバーからサブスク更新通知を受けてDBのステータスを更新する
※どうやってどのユーザーの更新かを判別するか…
1. サブスクステータス更新
2. AppStoreサーバーから通知を受け取ってFunctions起動
3. 不正なレシートではないか確認(2021.4.23)
4. 最新のレシート情報を保存(Functions)
5. 有効期限を元に有料機能の提供可否を判別(クライアント)
   ※世界標準時間(文字列)からDateに変換する必要がある
    (DBへの保存タイミングかクライアント側にて)(2021.4.23)
    →Date形式でDBに保存
 */

/*メモ
複数アカウントを所持している人が、サブスク購入情報を別アカウントに移行したい場合
1. subscriptionUserに更新対象のuserIDがあるか、
　　対象のトランザクションIDのuserIDが更新対象のuserIDと同じか確認
2. A 更新対象のID無し、更新対象と更新前のIDが同じ　→　・通常処理
　　B 更新対象と更新前のIDが違う場合　→　・更新前IDのユーザーデータから更新日を削除
　　　　　　　　　　　　　　　　　　　　　・通常処理
*/