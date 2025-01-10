###Microcenter Data Scraper

I wanted to do a small POC project using Azure functions. Funcitonally this just gets the open box discounted items in a category from Microcenter's website, compares it to the previous execution's data that is stored in Azure blob storage and then stores the new data to blob storage. If any new items show up or are reduced in price then it sends out an email using Azure Email Communication Service.

Don't mind the ugly code or everything being in one js file - just trying to see how everything can connect. To run locally you can use the Azure Function VS Code plugins. You'll need to do az login via Azure CLI or setup your default credential in some other way.