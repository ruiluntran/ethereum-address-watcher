'use strict';

const admin = require('firebase-admin');
const functions = require('firebase-functions');
const got = require('got');
const _ = require('lodash');
const md5 = require('md5');

admin.initializeApp();
const db = admin.firestore();
const walletFundsCollection = db.collection('walletFunds');


exports.etherscanWatcher = functions
  .pubsub
  .schedule('every 3 minutes')
  .onRun(async () => {

    const myAddress = functions.config().eth.address;
    const eth = await got({
      url: 'https://api.etherscan.io/api',
      searchParams: {
        module: 'account',
        action: 'balance',
        tag: 'latest',
        address: functions.config().eth.address,
        apikey: functions.config().etherscan.apikey
      }
    }).json();

    const erc20Transactions = await got({
      url: 'https://api.etherscan.io/api',
      searchParams: {
        module: 'account',
        action: 'tokentx',
        address: myAddress,
        apikey: functions.config().etherscan.apikey
      }
    }).json();

    const erc20 = await Promise.all(erc20Transactions.result.map(async item => {
      return {
        tokenName: item.tokenName,
        contractAddress: item.contractAddress,
        value: parseFloat(item.value) / Math.pow(10, parseInt(item.tokenDecimal)),
        from: item.from,
        to: item.to,
        tokenDecimal: parseInt(item.tokenDecimal),
        transactionIndex: parseInt(item.transactionIndex)
      }
    }));

    const transactionsByToken = _.chain(erc20).groupBy('contractAddress').value();

    const contracts = Object.keys(transactionsByToken);

    const tokens = [];

    contracts.forEach(contract => {
      const sum = parseFloat(_
        .chain(transactionsByToken[contract])
        .orderBy('transactionIndex')
        .reduce((sum, item) => {
          const value = item.from.toLowerCase() === myAddress.toLowerCase() ? (item.value * -1) : item.value;
          return sum + value;
        }, 0)
        .value());

      if (sum > 0.0000001) {
        tokens.push({
          name: transactionsByToken[contract][0].tokenName,
          contractAddress: transactionsByToken[contract][0].contractAddress,
          sum
        })
      }

    });

    const balance = {
      eth: eth.result / 1000000000000000000,
      tokens
    }

    const balanceHash = md5(JSON.stringify(balance));

    const walletFundsRef = await walletFundsCollection
      .where('balanceHash', '==', balanceHash)
      .get();


    if (!walletFundsRef.empty) {
      console.log('Wallet content did not changed');
      return;
    }

    await walletFundsCollection.add(Object.assign(balance, {balanceHash}))

    const webhookContent = [{name: 'ETH', value: balance.eth.toString(), inline: false}];

    tokens.forEach(item => {
      webhookContent.push({
        name: item.name, value: item.sum.toString(), inline: true
      })
    });

    await got({
      method: 'POST',
      url: functions.config().webhooks.discord,
      json: {
        content: 'Content of Wallet Changed',
        embeds: [{
          fields: webhookContent
        }]
      }
    }).catch(err => console.log(err))

    console.log('Notification send');
  });
