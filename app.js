/* eslint-disable no-constant-condition */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Helper function to get current date in epoch
const getCurrentEpoch = () => Math.floor(new Date().getTime() / 1000);

// Helper function to log messages
const log = (message) => console.log(`${new Date().toISOString()}: ${message}`);

// Load configuration
const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));

// Load existing products from products.json if it exists
const productsFilePath = path.resolve(__dirname, 'products.json');
let products = [];
if (fs.existsSync(productsFilePath)) {
  products = JSON.parse(fs.readFileSync(productsFilePath));
}

(async () => {
  const browser = await chromium.launch({
    channel: 'msedge',
  });

  const context = await browser.newContext({
    userAgent: config.userAgent,
    viewport: config.viewport,
    extraHTTPHeaders: config.extraHTTPHeaders,
  });

  context.setDefaultTimeout(config.globalTimeout);

  // Load cookies if exists
  const cookiesFilePath = path.resolve(__dirname, 'cookies.json');
  if (fs.existsSync(cookiesFilePath)) {
    const cookies = JSON.parse(fs.readFileSync(cookiesFilePath));
    await context.addCookies(cookies);
  }

  if (config.enableTracing) {
    await context.tracing.start({ screenshots: true, snapshots: true });
  }

  const page = await context.newPage();

  async function getItems(itemCards, websiteConfig, catType) {
    for (const item of await itemCards.all()) {
      const product = {
        store: websiteConfig.name,
        type: catType,
        date: getCurrentEpoch(),
      };

      let itemUrl = await item
        .locator(websiteConfig.selectors.itemTitle, { timeout: config.itemTimeout })
        .getAttribute('href');
      let itemTitle = await item
        .locator(websiteConfig.selectors.itemTitle, { timeout: config.itemTimeout })
        .textContent();
      let itemPrice = await item
        .locator(websiteConfig.selectors.itemPrice, { timeout: config.itemTimeout })
        .textContent();

      itemTitle = itemTitle.replace(/  +/g, ' ').replace(/,.*$/, '');
      itemPrice = itemPrice.replace(/\D/g, '');

      product.name = itemTitle;
      product.price = itemPrice;
      product.url = itemUrl;

      let existingProduct = products.find(
        (p) => p.url === product.url && p.price === product.price,
      );
      if (!existingProduct) {
        products.push(product);
      }
    }
  }

  const getProducts = async (websiteConfig, catType, catName) => {
    try {
      await page.goto(websiteConfig.url);

      // Save cookies
      const cookies = await context.cookies();
      fs.writeFileSync(cookiesFilePath, JSON.stringify(cookies, null, 2));

      // Replace 'CATEGORY_NAME' placeholder with actual category name
      const categoryLinkSelector = websiteConfig.selectors.categoryLink.replace(
        'CATEGORY_NAME',
        catName,
      );
      const categoryLinks = await page.locator(categoryLinkSelector);

      // Debugging: log the number of matched elements
      const categoryLinksCount = await categoryLinks.count();
      log(`Found ${categoryLinksCount} elements for category: ${catName}`);

      if (categoryLinksCount === 1) {
        await categoryLinks.first().click();
      } else if (categoryLinksCount > 1) {
        // Implement logic to choose the correct element if multiple are found
        for (let i = 0; i < categoryLinksCount; i++) {
          const element = categoryLinks.nth(i);
          const textContent = await element.textContent();
          if (textContent.trim() === catName) {
            await element.click();
            break;
          }
        }
      } else {
        throw new Error(`No matching elements found for category: ${catName}`);
      }

      const itemCards = await page.locator(websiteConfig.selectors.itemCards);

      await page.waitForLoadState('networkidle', { timeout: config.networkIdleTimeout });

      let pageIndex = 1;

      do {
        await getItems(itemCards, websiteConfig, catType);

        // Save products to JSON
        fs.writeFileSync(productsFilePath, JSON.stringify(products, null, 2));

        // Take a screenshot of the current page
        await page.screenshot({
          path: `${config.screenshotPath}_${websiteConfig.name}_${pageIndex}.jpg`,
        });

        await page.waitForTimeout(config.clickTimeout); // Add delay between page navigation to mimic human behavior

        const nextButton = await page.locator(websiteConfig.selectors.nextPageButton);
        if (await nextButton.isVisible()) {
          await nextButton.click();
        } else {
          break;
        }
        pageIndex++;
      } while (true);
    } catch (error) {
      log(
        `Error in getProducts(${catType}, ${catName}) for ${websiteConfig.name}: ${error}`,
      );
    }
  };

  const retryOperation = async (operation, retries = 3) => {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await operation();
        break;
      } catch (error) {
        if (attempt === retries) {
          console.error(`Operation failed after ${retries} attempts:`, error);
        } else {
          console.log(`Retrying operation (attempt ${attempt} of ${retries})...`);
        }
      }
    }
  };

  for (const website of config.websites) {
    for (const category of website.categories) {
      await retryOperation(() => getProducts(website, category.type, category.name), 3);
    }
  }

  // Stop tracing after the last page
  if (config.enableTracing) {
    await context.tracing.stop({ path: config.traceFilePath });
  }

  // Close the browser
  await browser.close();
})();
