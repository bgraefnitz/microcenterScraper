const { app, input, output } = require('@azure/functions');
const { JSDOM } = require('jsdom');
const crypto = require('crypto');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const { BlobServiceClient, StorageSharedKeyCredential } = require("@azure/storage-blob");
const { DefaultAzureCredential } = require("@azure/identity");
const Readable = require('stream').Readable;
const { EmailClient } = require("@azure/communication-email");

app.http('microcenterHttpEndpoint', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    return await doWork();
  },
});

app.http('microcenterSnoozeHttpEndpoint', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'microcenterSnoozeHttpEndpoint/{id:int?}',
  handler: async (request, context) => {
    const id = request.params.id;
    return await snooze(id);
  },
});

app.timer('microcenterTimer', {
  schedule: '0 */5 * * * *',
  handler: async (myTimer, context) => {
    return await doWork();
  },
});

async function snooze(id) {
  try {
    const previousData = await getPreviousData("snooze.json");
    if (previousData.includes(id)) {
      return { body: `item with id ${id} had already been snoozed` };
    } else {
      previousData.push(id);
      await persistNewData(previousData, "snooze.json");
      return { body: `item with id ${id} snoozed` };
    }
  } catch (exception) {
    console.error(`Error in snooze: ${exception}`);
    return { body: `Error in snooze: ${exception.message}`};
  }
}

async function doWork() {
  const previousData = await getPreviousData();
  if (typeof(previousData) === 'string') return { body: previousData }
  const currentData = await getCurrentData('https://www.microcenter.com/search/search_results.aspx?N=4294964290&prt=clearance&NTK=all&sortby=pricehigh');
  if (typeof(currentData) === 'string') return { body: currentData }
  const differences = await detectDifferences(previousData, currentData);
  if (typeof(differences) === 'string') return { body: differences }
  if (differences.length > 0) {
    const emailResponse = await sendEmail(differences);
    if (typeof(emailResponse) === 'string') return { body: emailResponse }
    const newPersistedData = mergeChanges(previousData, differences);
    await persistNewData(newPersistedData);
    console.log(JSON.stringify(differences));
  }
  return { body: JSON.stringify(differences) };
}

function mergeChanges(previousData, differences) {
  differences.forEach(difference => {
    const matchingPreviousItem = previousData.filter(previousItem => {return previousItem.name === difference.name});
    // if wasn't in previous it is new, push it as a difference
    if (!matchingPreviousItem || matchingPreviousItem.length === 0) {
      difference.changeTimestamp = Date.now();
      previousData.push(difference);
    }
    // if it was in previous but now has lower price, update price
    if (matchingPreviousItem && matchingPreviousItem.length > 0 && difference.price < matchingPreviousItem[0].price) {
      matchingPreviousItem[0].price = difference.price;
      matchingPreviousItem[0].changeTimestamp = Date.now();
    }
  });

  return previousData;
}

async function sendEmail(items) {
  try {
    const defaultCredential = new DefaultAzureCredential();
    const emailClient = new EmailClient('https://webscrapercommunicationservice.unitedstates.communication.azure.com', defaultCredential);
    const messageHtml = getHtml(items);
    const message = {
      senderAddress: "DoNotReply@e1e6baa5-a1fa-4cd7-bf09-b9c2edd46f24.azurecomm.net",
      content: {
        subject: "Microcenter OpenBox Discount Change",
        html: messageHtml,
      },
      recipients: {
        to: [
          {
            address: "bgraefnitz@gmail.com",
            displayName: "Brian Graefnitz",
          },
        ],
      },
    };
    
    const poller = await emailClient.beginSend(message);
    const response = await poller.pollUntilDone();
    return response;
  } catch (exception) {
    console.error(`Error in sendEmail: ${exception}`);
    return `Error in sendEmail: ${exception.message}`;
  }
}

function getHtml(items) {
  var html = "<table border='1' style=\"border-collapse:collapse;\">";
  html = html.concat("<th>Item</th><th>Price</th><th>Prev Price</th><th>Orig Price</th><th>Ignore</th>");
  items.forEach(item => {
    const ignoreUrl = "https://webscrapingbdg.azurewebsites.net/api/microcenterSnoozeHttpEndpoint/".concat(item.id);
    const itemString = `<tr><td><img width=\"120px\" src=\"${item.image}\"/><br clear=\"all\"/><a href=\"${item.url}\">${item.name}</a></td><td><b>$${item.price}</b></td><td>$${item.oldPrice}</td><td>$${item.originalPrice}</td><td><a href=\"${ignoreUrl}\">Ignore</a></td></tr>`;
    html = html.concat(itemString);
  });
  html = html.concat("</table>");
  return html;
}

async function detectDifferences(previousData, currentData) {
  const differences = []
  try {
    const ignoreData = await getPreviousData("snooze.json");
    currentData.forEach(currentItem => {
      if (!ignoreData.includes(currentItem.id)) {
        const matchingPreviousItem = previousData.filter(previousItem => {return previousItem.name === currentItem.name});
        // if wasn't in previous it is new, push it as a difference
        if (!matchingPreviousItem || matchingPreviousItem.length === 0) {
          differences.push(currentItem);
        }
        // if it was in previous but now has lower price, push it as a difference and update price
        if (matchingPreviousItem && matchingPreviousItem.length > 0 && currentItem.price < matchingPreviousItem[0].price) {
          currentItem.oldPrice = matchingPreviousItem[0].price;
          differences.push(currentItem);
        }
      }
    });
    // add any items that were in previous but not in current to current so that we have price history
    return differences;
  } catch (exception) {
    console.error(`Error in detectDifferences: ${exception}`);
    return `Error in detectDifferences: ${exception.message}`;
  }
}

async function persistNewData(data, filename = "data.json") {
  try {
    const defaultCredential = new DefaultAzureCredential();
    const blobClient = new BlobServiceClient('https://webscrapingb98b.blob.core.windows.net', defaultCredential);
    const container = blobClient.getContainerClient("app-package-microcenter-d9c0f45");
    const blockBlob = container.getBlockBlobClient(filename);
    const dataStream = getStream(JSON.stringify(data));
    await blockBlob.uploadStream(dataStream);
    return;
  } catch (exception) {
    console.error(`Error in persistNewData: ${exception}`);
    return `Error in persistNewData: ${exception.message}`;
  }
}

function getStream(textData) {
  const s = new Readable();
  s._read = () => {}; // redundant? see update below
  s.push(textData);
  s.push(null);
  return s;
}

async function getPreviousData(filename = "data.json") {
  try {
    const defaultCredential = new DefaultAzureCredential();
    const blobClient = new BlobServiceClient('https://webscrapingb98b.blob.core.windows.net', defaultCredential);
    const container = blobClient.getContainerClient("app-package-microcenter-d9c0f45");
    const file = container.getBlobClient(filename);
    const data = await file.download();
    const downloadedData = await streamToBuffer(data.readableStreamBody);
    const previousData = downloadedData.toString();
    return JSON.parse(previousData);
  } catch (exception) {
    console.error(`Error in getPreviousData: ${exception}`);
    return `Error in getPreviousData: ${exception.message}`;
  }
}

async function streamToBuffer(readableStream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readableStream.on("data", (data) => {
      chunks.push(data instanceof Buffer ? data : Buffer.from(data));
    });
    readableStream.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    readableStream.on("error", reject);
  });
}

async function getCurrentData(url) {
  try {
    const response = await fetch(url, {
      "headers": {
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "accept-language": "en-US,en;q=0.9",
        "cache-control": "max-age=0",
        "priority": "u=0, i",
        "sec-ch-device-memory": "8",
        "sec-ch-ua": "\"Google Chrome\";v=\"131\", \"Chromium\";v=\"131\", \"Not_A Brand\";v=\"24\"",
        "sec-ch-ua-arch": "\"x86\"",
        "sec-ch-ua-full-version-list": "\"Google Chrome\";v=\"131.0.6778.205\", \"Chromium\";v=\"131.0.6778.205\", \"Not_A Brand\";v=\"24.0.0.0\"",
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-model": "\"\"",
        "sec-ch-ua-platform": "\"Windows\"",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
        "sec-fetch-user": "?1",
        "upgrade-insecure-requests": "1",
        "cookie": "asusSP=; MccGuid=04e90399-baf5-4330-a83b-49a667efcf9d; _mclist=ListGuid=9b9a04a0-6349-4438-9ddb-c6b59ebd6019; __mmapiwsid=018ef2c7-d737-7480-a9d0-b2760eef3006:13fe5a2c969921b05aafc254f6503edd86c27052; _mccart=CartID=5dcff9fc-070c-456b-985b-9b1393423302&Quantity=0&RWOCartID=; _ga=GA1.1.226838984.1726286454; a1ashgd=t0f29j7hcut00000t0f29j7hcut00000; __exponea_etc__=713bd2f6-54ea-400e-b18d-2dd49dfb06a6; __eoi=ID=9bef0648e98ff125:T=1726286466:RT=1726863744:S=AA-AfjYvCe1_qEQVpNoecTt5BbNs; datadome=fmj1LBDeJZx3Vo22ZOGOYbgZuwgB1FxlXD5ipdrofdfxagxIrMSisLjwvI_gY1iXTOsamhTU~kf1wioXBuVgCOSnJaizFNSg2KCpY64pPk0qXPGz2b8MhxhVgugkQg8P; _conv_r=s%3Awww.reddit.com*m%3Areferral*t%3A*c%3A; _conv_v=vi%3A1*sc%3A7*cs%3A1729657634*fs%3A1726286454*pv%3A20*exp%3A%7B1004103372.%7Bv.1-g.%7B%7D%7D%7D*ps%3A1729649121; _gcl_au=1.1.950750139.1734403999; T682573=VEsgUmFjaW5nIFNpbmdsZS9UcmlwbGUgTW9uaXRvciBNb3VudA==; S682573=724229; T686324=VEsgUmFjaW5nIFJpZ2h0IEFybSBGbGlnaHQgU2ltIE1vdW50; S686324=759282; SortBy=pricehigh; storeSelected=165; BVBRANDID=20ec8331-42e7-43c6-b9e8-bc8734db6874; cto_bundle=B5xg2V9xUjk5dlh3SUlqSm1FNGh2MGYlMkI4cHMwR1hFRHRaWGVWQjBZQjc2aVZxNCUyRlVmVDBQMmsxUkt0b3RwMkRIN1ZPbmIzc1JEdU02RjhmSFhzMmYlMkJ1eUNZNW1oMUdnazJmYUNNNDdLZDYweUJlRUx6QUV5YlVacjVOWHhFakNPcGVRVlQlMkJ2V1NobHd3ZW9mZ2Z2WExHeFpEaHZPd1diUExmaXVtciUyRnhDQnZkNklHdEZuejhtWEl0bEREaVJkd2YyWkoyTkxSRXV5cFhlJTJGdmxTVU9hMTRPUTVURHBJNkxtdlhrYm91bzdqdVIyZWFTUFByNTkxMGklMkZjejBrUmNwbkVkNVFmcnZ1YlpYMzRtRG1lV0dkTzJFRkxRJTNEJTNE; myStore=true; lat=0; long=0; rpp=24; charlotteDistance=5708.84528339399; miamiDistance=5621.65802888577; santaclaraDistance=7944.2355928346; isOnWeb=False; bcu2=set; ipaddr=195.252.198.43; Mlogin=closed; viewtype=grid; c_clientId=226838984.1726286454; geolocated=true; _clck=myr6by%7C2%7Cfsf%7C0%7C1718; ut=MzUwMjI2NTUzNjEyNQ==; BVBRANDSID=35de6803-ec5a-4ef1-9aad-c384417911f3; __exponea_time2__=12.637119770050049; rearview=330292,686324,682573; T330292=VGhydXN0bWFzdGVyIE1GRCBDb3VnYXIgUGFjaw==; S330292=659045; _rdt_uuid=1726286454412.1f019dc6-6aeb-448b-9bb8-93fca7368b47; wisepops=%7B%22popups%22%3A%7B%7D%2C%22sub%22%3A0%2C%22ucrn%22%3A30%2C%22cid%22%3A%2249074%22%2C%22v%22%3A4%2C%22bandit%22%3A%7B%22recos%22%3A%7B%7D%7D%7D; wisepops_props=%7B%22pdpCat%22%3A%22%22%2C%22searchCategory%22%3A%22%22%2C%22currentBrowseCategories%22%3A%224294966640%20-%20UPS%20Systems%2C4294966938%20-%20Graphics%20Cards%20%26%20Accessories%2C4294966998%20-%20Computer%20Parts%2C4294961019%20-%20Gaming%20Controllers%2C4294966937%20-%20Graphics%20Cards%2C4294964290%20-%20Gaming%22%2C%22StoreInfoModalOpen%22%3A%22False%22%2C%22NewStoreInfoModalOpen%22%3A%22False%22%2C%22NeedsLoginModalOpen%22%3A%22False%22%2C%22minutessincedisplay%22%3A0%2C%22PrivacyModalOpen%22%3Afalse%2C%22firstName%22%3A%22Customer%22%2C%22customerLoggedIn%22%3A%22False%22%2C%22customerIdentified%22%3A%22True%22%2C%22supressAds%22%3A%22False%22%2C%22currentStore%22%3A%22165%22%2C%22currentStoreState%22%3A%22IN%22%2C%22currentStoreCity%22%3A%22Indianapolis%22%2C%22storeDistance%22%3A5.0665%2C%22miamiDistance%22%3A%225621.65802888577%22%2C%22charlotteDistance%22%3A%225708.84528339399%22%2C%22santaclaraDistance%22%3A%227944.2355928346%22%2C%22isMobile%22%3A%22False%22%2C%22currentCartCategories%22%3A%22%22%2C%22currentListCategories%22%3A%22%22%2C%22recentProductViewedCategories%22%3A%22Gaming%20Controllers%2CGaming%20Accessories%22%2C%22NE1002%22%3A%22VE100001%22%2C%22NE1003%22%3A%22VE100004%22%2C%22NE1005%22%3A%22VE100040%22%2C%22NE1006%22%3A%22VE100725%22%2C%22NE1007%22%3A%22VE100558%22%2C%22NE1008%22%3A%22VE100003%22%2C%22NE1009%22%3A%22VE100002%22%2C%22NE1010%22%3A%22VE100002%22%2C%22NE1011%22%3A%22VE103335%22%2C%22NE1012%22%3A%22VE100029%22%2C%22NE1013%22%3A%22VE100004%22%2C%22NE1014%22%3A%22VE100001%22%2C%22NE1015%22%3A%22VE104283%22%2C%22NE1016%22%3A%22VE100003%22%2C%22NE1021%22%3A%22VE100002%22%2C%22NE1025%22%3A%22VE100041%22%2C%22NE1026%22%3A%22VE100006%22%2C%22NE1027%22%3A%22VE100002%22%2C%22NE1030%22%3A%22VE100002%22%2C%22NE1503%22%3A%22VE100002%22%2C%22NE1550%22%3A%22VE100002%22%2C%22lastPurchaseDays%22%3A%22348.185769767104%22%2C%22lastPurchaseCategories%22%3A%22Processors%2FCPUs%7C123%2CMotherboards%7C122%2CDesktop%20Memory%2FRAM%7C491%2CThermal%20Compound%2C%20Paste%7C151%22%7D; wisepops_visitor=%7B%22S5XeyXKS9e%22%3A%22da96d142-9e7d-419b-91d8-676a4402ca7f%22%7D; wisepops_visits=%5B%222025-01-09T05%3A34%3A47.826Z%22%2C%222025-01-09T05%3A33%3A45.094Z%22%2C%222025-01-09T02%3A57%3A12.596Z%22%2C%222025-01-06T17%3A20%3A42.557Z%22%2C%222024-12-28T20%3A54%3A22.019Z%22%2C%222024-12-26T04%3A47%3A26.165Z%22%2C%222024-12-25T23%3A34%3A56.001Z%22%2C%222024-12-19T02%3A55%3A01.987Z%22%2C%222024-12-17T06%3A29%3A18.493Z%22%2C%222024-12-17T06%3A26%3A52.441Z%22%5D; wisepops_session=%7B%22arrivalOnSite%22%3A%222025-01-09T05%3A34%3A47.826Z%22%2C%22mtime%22%3A1736400888852%2C%22pageviews%22%3A1%2C%22popups%22%3A%7B%7D%2C%22bars%22%3A%7B%7D%2C%22sticky%22%3A%7B%7D%2C%22countdowns%22%3A%7B%7D%2C%22src%22%3Anull%2C%22utm%22%3A%7B%7D%2C%22testIp%22%3Anull%7D; _ga_CSBPEX4VCV=GS1.1.1736400824.24.1.1736401295.54.0.0"
      },
      "referrerPolicy": "strict-origin-when-cross-origin",
      "body": null,
      "method": "GET"
    });
    const html = await response.text();

    // Parse the HTML content using JSDOM
    const dom = new JSDOM(html);
    const document = dom.window.document;
    return listProducts(document);
  } catch (error) {
    console.error(`An error occurred while fetching the website content: ${error}`);
    return `Error in getCurrentData: ${exception.message}`;
  }
}

function listProducts(document) {
  const productItems = document.querySelectorAll('.product_wrapper');
  const productList = []

  productItems.forEach(item => {
    // Extract relevant product information (adjust selectors as needed)
    const product = item.querySelector('[data-list="Search Results"]');
    const productName = product.getAttribute('data-name');
    const productId = product.getAttribute('data-id');
    const productUrl = product.getAttribute('href');
    const productImage = item.querySelector('.SearchResultProductImage').getAttribute('src');
    const productPriceNode = item.querySelector('.price-label');
    const productPrice = productPriceNode.firstElementChild.textContent.replace('$', '');
    const productOriginalPrice = item.querySelector('.ObStrike').textContent;
    // Extract other details like image, description, etc.
    const listItem = { name: productName, id: productId, price: Number(productPrice), image: productImage, originalPrice: Number(productOriginalPrice), url: "https://www.microcenter.com" + productUrl };
    productList.push(listItem);
  });

  return productList;
}