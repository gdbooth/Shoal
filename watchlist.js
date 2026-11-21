// The default stocks Shoal watches: shared by the app (window.ShoalWatchlist) and the server's daily
// trading job (loaded through vm). [symbol, name, sector, rough price (only seeds the fictional market)].
// The original 25 come first: IG gets the first 30 symbols and the intraday lab the first 40.
(function (root) {
  'use strict';
  const CATALOG = [
  ['NVDA','NVIDIA','Tech',140], ['AAPL','Apple','Tech',230], ['MSFT','Microsoft','Tech',420], ['TSLA','Tesla','Disc',250],
  ['JPM','JPMorgan','Fin',220], ['XOM','Exxon','Energy',115], ['COST','Costco','Cons',890], ['AMD','AMD','Tech',150],
  ['META','Meta','Comm',560], ['GOOG','Alphabet','Comm',175], ['BAC','Bank of America','Fin',42], ['WFC','Wells Fargo','Fin',65],
  ['JNJ','J&J','Health',155], ['LLY','Eli Lilly','Health',800], ['UNH','UnitedHealth','Health',560], ['CVX','Chevron','Energy',155],
  ['COP','ConocoPhillips','Energy',110], ['WMT','Walmart','Cons',80], ['PG','Procter & Gamble','Cons',165], ['CAT','Caterpillar','Indus',360],
  ['HON','Honeywell','Indus',210], ['NEE','NextEra Energy','Util',75], ['SO','Southern Co','Util',88], ['LIN','Linde','Mat',450],
  ['FCX','Freeport-McMoRan','Mat',45],
  // 75 more
  ['AMZN','Amazon','Disc',190], ['AVGO','Broadcom','Tech',170], ['ORCL','Oracle','Tech',170], ['CRM','Salesforce','Tech',280],
  ['ADBE','Adobe','Tech',480], ['INTC','Intel','Tech',22], ['CSCO','Cisco','Tech',58], ['QCOM','Qualcomm','Tech',165],
  ['TXN','Texas Instruments','Tech',200], ['IBM','IBM','Tech',220], ['NOW','ServiceNow','Tech',950], ['INTU','Intuit','Tech',640],
  ['AMAT','Applied Materials','Tech',180], ['MU','Micron','Tech',100], ['ACN','Accenture','Tech',350],
  ['NFLX','Netflix','Comm',750], ['DIS','Disney','Comm',100], ['CMCSA','Comcast','Comm',40], ['T','AT&T','Comm',22],
  ['VZ','Verizon','Comm',42], ['TMUS','T-Mobile US','Comm',230],
  ['HD','Home Depot','Disc',400], ['MCD',"McDonald's",'Disc',290], ['NKE','Nike','Disc',75], ['LOW',"Lowe's",'Disc',260],
  ['SBUX','Starbucks','Disc',95], ['BKNG','Booking','Disc',4800], ['TJX','TJX','Disc',120], ['GM','General Motors','Disc',50],
  ['KO','Coca-Cola','Cons',63], ['PEP','PepsiCo','Cons',160], ['PM','Philip Morris','Cons',125], ['MO','Altria','Cons',52], ['CL','Colgate-Palmolive','Cons',92],
  ['C','Citigroup','Fin',65], ['GS','Goldman Sachs','Fin',520], ['MS','Morgan Stanley','Fin',120], ['BLK','BlackRock','Fin',950],
  ['SCHW','Charles Schwab','Fin',70], ['AXP','American Express','Fin',270], ['V','Visa','Fin',290], ['MA','Mastercard','Fin',500],
  ['USB','U.S. Bancorp','Fin',47], ['COF','Capital One','Fin',160],
  ['PFE','Pfizer','Health',28], ['MRK','Merck','Health',100], ['ABBV','AbbVie','Health',180], ['TMO','Thermo Fisher','Health',560],
  ['ABT','Abbott','Health',115], ['DHR','Danaher','Health',240], ['BMY','Bristol-Myers Squibb','Health',50], ['AMGN','Amgen','Health',300],
  ['GILD','Gilead','Health',85], ['MDT','Medtronic','Health',85],
  ['SLB','SLB','Energy',42], ['EOG','EOG Resources','Energy',125], ['OXY','Occidental','Energy',52],
  ['GE','GE Aerospace','Indus',170], ['UPS','UPS','Indus',130], ['BA','Boeing','Indus',155], ['RTX','RTX','Indus',120],
  ['LMT','Lockheed Martin','Indus',520], ['DE','Deere','Indus',400], ['UNP','Union Pacific','Indus',240], ['MMM','3M','Indus',125],
  ['FDX','FedEx','Indus',280], ['EMR','Emerson','Indus',120],
  ['NEM','Newmont','Mat',50], ['SHW','Sherwin-Williams','Mat',360],
  ['DUK','Duke Energy','Util',112], ['AEP','American Electric Power','Util',98], ['EXC','Exelon','Util',38],
  ['PLD','Prologis','RE',115], ['AMT','American Tower','RE',210], ['SPG','Simon Property','RE',170],
];
  root.ShoalWatchlist = { CATALOG, DEFAULT: CATALOG.map(x => x[0]) };
})(typeof window !== 'undefined' ? window : globalThis);
