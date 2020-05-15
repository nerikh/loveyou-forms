// FIREBASE FUNCTIONS SDK: to create Cloud Functions and setup triggers
const functions = require('firebase-functions');
// FIREBASE ADMIN SDK: to access the firestore (or firebase) database
const admin = require('firebase-admin');
// DATABASE CREDENTIALS: so cloud functions can authenticate with the database
const serviceAccount = require('./service-account.json'); // download from firebase console
admin.initializeApp({ // initialize firebase admin with credentials
  credential: admin.credential.cert(serviceAccount), // So functions can connect to database
  databaseURL: 'https://loveyou-forms.firebaseio.com' // if using FireBase database (not FireStore)
});
const db = admin.firestore(); // FireStore database reference
// TIMESTAMPS: for adding server-timestamps to database docs
const FieldValue = require('firebase-admin').firestore.FieldValue; // Timestamp here
const timestampSettings = { timestampsInSnapshots: true }; // Define timestamp settings
db.settings(timestampSettings); // Apply timestamp settings to database settingsA
// FUNCTION SUPPORT: for Firestore-to-Sheets function (Google Sheets)
const moment = require('moment-timezone'); // Timestamp formats and timezones
const { google } = require('googleapis');
const sheets = google.sheets('v4'); // Google Sheets
const jwtClient = new google.auth.JWT({ // JWT Authentication (for google sheets)
  email: serviceAccount.client_email, // <--- CREDENTIALS
  key: serviceAccount.private_key, // <--- CREDENTIALS
  scopes: ['https://www.googleapis.com/auth/spreadsheets'] // read and write sheets
});
// AKISMET
const { AkismetClient } = require('akismet-api/lib/akismet.js'); // had to hardcode path
const key = '5c73ad452f54'
const blog = 'https://lyfdev.web.app'
const client = new AkismetClient({ key, blog })

/*------------------------------------------------------------------------------
  Utility Functions
  For use by cloud functions
------------------------------------------------------------------------------*/

const logErrorInfo = error => ({
  Error: 'Description and source line:',
  description: error,
  break: '**************************************************************',
  Logger: ('Error reported by log enty at:'),
  info: (new Error()),
});

/*------------------------------------------------------------------------------
  Form-Handler HTTP Cloud Function
  Receives data sent by form submission and creates database entry
  Terminate HTTP cloud functions with res.redirect(), res.send(), or res.end()
------------------------------------------------------------------------------*/

exports.formHandler = functions.https.onRequest(async (req, res) => {

  let messages;

  try {

    /*--------------------------------------------------------------------------
      Check: Request content-type, if Authorized app, if Form submit disabled:
      Stop processing if checks fail
    --------------------------------------------------------------------------*/
   
    // Request Content-Type: stop processing if content type is not 'text/plain'
    const contentType = req.headers['content-type'];
    if (typeof contentType === 'undefined' 
        || contentType.toLowerCase() !== 'text/plain') {
      console.warn(`Request header 'content-type' must be 'text/plain'`);
      return res.end();
    }
    
    const formResults = JSON.parse(req.body); // parse req.body json-text-string

    const appRef = await db.collection('app').doc(formResults.appKey.value).get();
    const app = appRef.data();

    // App key: if exists continue with global and app condition checks
    if (app) {
      const globalAppRef = await db.collection('global').doc('app').get();
      const globalApp = globalAppRef.data();
      // Messages: use global or app-specific messages
      // global boolean 0/1, if set to 2 bypass global & use app-specific boolean
      if (app.condition.messageGlobal || app.condition.messageGlobal == null) {
        messages = globalApp.message;
      } else {
        messages = app.message;
      }
      // CORS validation: stop cloud function if CORS check does not pass
      // global boolean 0/1, if set to 2 bypass global & use app-specific boolean
      if (!globalApp.condition.corsBypass
          || (globalApp.condition.corsBypass === 2 && !app.condition.corsBypass)
        ) {
        // restrict to url requests that match the app
        res.setHeader('Access-Control-Allow-Origin', app.appInfo.appUrl);
        // end processing if url does not match (req.headers.origin = url)
        if (req.headers.origin !== app.appInfo.appUrl) { 
          console.warn('CORS Access Control: Origin Url does not match App Url.');
          // no error response sent because submit not from approved app
          return res.end();
        }
      } else {
        // allow * so localhost (or any source) recieves response
        res.setHeader('Access-Control-Allow-Origin', '*');
      }
      // Form Submit Enabled/Disabled: stop cloud function if submitForm disabled
      // global boolean 0/1, if set to 2 bypass global & use app-specific boolean
      if (!globalApp.condition.submitForm
          || (globalApp.condition.submitForm === 2 && !app.condition.submitForm)
        ) {
        console.warn(`Form submit disabled for app "${app.appInfo.appName}"`);
        // return error response because submit is from approved app
        throw (messages.error.text);
      }
    } else {
      console.warn('App Key does not exist.');
      // no error response sent because submit not from approved app
      return res.end();
    }
    

    /*--------------------------------------------------------------------------
      Props/Fields
      Compile database props/fields and form fields as 'props' to be handled as
      object entries; sanitize; add to structured object; submit to database
    --------------------------------------------------------------------------*/

    const appKey = app.id;
    const appInfo = app.appInfo;

    //
    // Form Field Name Defaults: select from db all formField default fields
    // Return Object of docs
    //
    const formFieldsDefaultRef = await db.collection('formField').where('default', '==', true).get();
    const formFieldsDefault = formFieldsDefaultRef.docs.reduce((a, doc) => {
      a[doc.id] = doc.data();
      return a;
    }, {});
    
    //
    // Props All: consolidate props and fields last-in overwrites previous 
    //
    const propsAll = { appKey, ...formFieldsDefault, ...formResults, ...appInfo };

    ////////////////////////////////////////////////////////////////////////////
    // Props Allowed Entries: reduce to allowed props
    //
    // Remove from 'props' fields not used for database or code actions because:
    // 1) prevents database errors due to querying docs (formField) using 
    //    disallowed values; e.g. if html <input> had name="__anything__"
    //    doc limits: https://firebase.google.com/docs/firestore/quotas#limits
    // 2) only fields used for database or code actions will be included
    //
    // Props Whitelist: compiled from database
    // Database Schema
    //   formField/'all required' --> formFieldsRequired
    //   formTemplate/'templateName'/fields --> formTemplateFields
    //   app/'appKey'/appInfo.*props --> appInfo

    //
    // Form Field Names Required: fields required for cloud function to work
    // Return Array of field names
    //
    const formFieldsRequiredRef = await db.collection('formField').where('required', '==', true).get();
    const formFieldsRequired = formFieldsRequiredRef.docs.reduce((a, doc) => {
      a.push(doc.id);
      return a;
    }, []);

    //
    // Form Template Fields:
    // Array of field names for submitForm/*/template.data used by 'trigger email' extension
    //
    const formTemplateRef = await db.collection('formTemplate').doc(propsAll.templateName.value).get();
    const formTemplateFields = formTemplateRef.data().fields;
  
    // Props Whitelist:
    // Array of prop keys allowed for database or code actions last-in overwrites previous
    const propsWhitelist = [ ...formFieldsRequired, ...formTemplateFields, ...Object.keys(appInfo) ];

    //
    // Props Allowed Entries: entries used for database or code actions
    // Return Object
    //
    const propsAllowedEntries = Object.entries(propsAll).reduce((a, [key, value]) => {
      if (propsWhitelist.includes(key)) {
        a[key] = value; 
      } 
      return a;
    }, {});
    //
    // [END] Props Allowed Entries: reduce to allowed props
    ////////////////////////////////////////////////////////////////////////////

   const props = (() => {

      const trim = value => value.toString().trim();
      const props =  { toUids: [], templateData: {} };

      // compare database fields with form-submitted props and build object
      const set = propsToParse => Object.entries(propsToParse).forEach(([prop, data]) => {
        // appInfo fields do not have a 'value' property
        if (appInfo.hasOwnProperty(prop)) {
          props[prop] = trim(data);
        } else {
          // form fields have 'value' property
          props[prop] = trim(data.value);
        }
        // toUids: appKey unless if spam then use [ alert message ]
        if (prop === 'appKey') {
           props.toUids = trim(data.value);
        } else if (prop === 'toUidsSpamOverride') {
           props.toUids = trim(data.value);
        }
        // Form Template Fields: Whitelist check [START]
        if (formTemplateFields.includes(prop) && appInfo.hasOwnProperty(prop)) {
          props.templateData[prop] = data;
        } else if (formTemplateFields.includes(prop)) {
          props.templateData[prop] = trim(data.value);
        }
        // Form Template Fields: Whitelist check [END]
      });

      const get = ({ templateData, urlRedirect = false, ...key } = props) => ({
        data: {
          appKey: key.appKey, 
          createdDateTime: FieldValue.serverTimestamp(), 
          from: key.appFrom,
          ...key.spam && { spam: key.spam }, // only available if akismet enabled
          toUids: [ key.toUids ], 
          replyTo: templateData.email,
          template: { 
            name: key.templateName, 
            data: templateData
          }
        },
        urlRedirect: urlRedirect
      });
 
      return {
        set: props => {
          return set(props);
        },
        get: () => {
          return get();
        }
      }
    })();
    //
    // [END] Data Sanitize & Set Props
    ////////////////////////////////////////////////////////////////////////////

    //
    // Props: Set Allowed Props 
    //
    props.set(propsAllowedEntries);


    /*--------------------------------------------------------------------------
      Akismet Spam Check
      Minimally checks IP Address and User Agent
      Also checks fields defined as 'content' and 'other' based on config
    --------------------------------------------------------------------------*/

    try {
      // Ternary with reduce
      // returns either 'content' fields as string, or 'other' props as {}
      const akismetProps = fieldGroup => accumulatorType =>
        // does data/array exist, and if so does it have length > 0
        formTemplateRef.data().fieldsAkismet[fieldGroup]
          && formTemplateRef.data().fieldsAkismet[fieldGroup].length > 0
        // if exists then reduce
        ? (formTemplateRef.data().fieldsAkismet[fieldGroup].reduce((a, field) => {
          if (fieldGroup === 'content') {
            return a + props.get().data.template.data[field] + " ";
          } else if (fieldGroup === 'other') {
            a[field] = props.get().data.template.data[field];
            return a;
          }
        }, accumulatorType))
        // null prevents from being added to object
        : null;

      // Data to check for spam
      const testData = {
        ...req.ip && { ip: req.ip },
        ...req.headers['user-agent'] && { useragent: req.headers['user-agent'] },
        ...akismetProps('content')('') && { content: akismetProps('content')('') },
        ...akismetProps('other')({})
      }

      // Test if data is spam -> a successful test returns boolean
      const isSpam = await client.checkSpam(testData);
      // if spam suspected
      if (typeof isSpam === 'boolean' && isSpam) {
        props.set({spam: { value: 'true' }});
        props.set({toUidsSpamOverride: { value: "SPAM_SUSPECTED_DO_NOT_EMAIL" } });
      } 
      // if spam check passed
      else if (typeof isSpam === 'boolean' && !isSpam) {
        props.set({spam: { value: 'false' }});
      }

    } catch(err) {

      // Validate API Key
      const isValid = await client.verifyKey();
      if (isValid) {
        console.info('Akismet: API key is valid');
      } else if (!isValid) {
        console.warn('Akismet: Invalid API key');
      }

      // if api key valid -> error is likely network failure of client.checkSpam()
      console.error("Akismet ", err);

    }


    // For serverTimestamp to work must first create new doc key then 'set' data
    const newKeyRef = db.collection('submitForm').doc();
    // update the new-key-record using 'set' which works for existing doc
    newKeyRef.set(props.get().data);


    /*--------------------------------------------------------------------------
      Response to request
    --------------------------------------------------------------------------*/
 
    // return response object (even if empty) so client can finish AJAX success
    return res.status(200).send({
      data: {
        redirect: props.get().urlRedirect,
        message: messages.success
      }
    });

  } catch(error) {
    
    console.error(logErrorInfo(error));

    return res.status(500).send({
      error: {
        message: messages.error
      }
    });

  } // end catch

});

/*------------------------------------------------------------------------------
  Firestore-to-Sheets Trigger Cloud Function
  Listens for new 'submitForm' collection docs and adds data to google sheets.
  If required, creates new sheet(tab) and row header.
------------------------------------------------------------------------------*/

exports.firestoreToSheets = functions.firestore.document('submitForm/{formId}')
  .onCreate(async (snapshot, context) => {

  try {

    /*--------------------------------------------------------------------------
      Prepare row data values and sheet header
    --------------------------------------------------------------------------*/

    // Form Submission: values from Snapshot.data()
    const { appKey, createdDateTime, template: { data: { ...templateData }, 
      name: templateName  } } = snapshot.data();

    // App Doc
    const appRef = await db.collection('app').doc(appKey).get();
    const app = appRef.data();
 
    // Template: two sort-ordered arrays of strings
    // headerRowSheet array is sorted according to desired sheets visual
    // templateData array is sorted to match the order of headerRowSheet
    const formTemplateRef = await db.collection('formTemplate').doc(templateName).get();
    const formTemplate = formTemplateRef.data();

    // Header fields for sheet requires nested array of strings [ [ 'Date', 'Time', etc ] ]
    const headerRowSheet = [( formTemplate.headerRowSheet )]; 

    ////////////////////////////////////////////////////////////////////////////
    // Row Data: Sort & Merge
    //
    // Strings to 'prop: value' objects so data to be merged has uniform format
    // timezone 'tz' string defined by momentjs.com/timezone:
    // https://github.com/moment/moment-timezone/blob/develop/data/packed/latest.json
    const dateTime = createdDateTime.toDate(); // toDate() is firebase method
    const createdDate = moment(dateTime).tz(app.appInfo.appTimeZone).format('L');
    const createdTime = moment(dateTime).tz(app.appInfo.appTimeZone).format('h:mm A z');
    // Reduce array formTemplate.templateData, this returns an object that 
    // is sort-ordered to match database headerRowSheet fields of array.
    const templateDataSorted = formTemplate.fields.reduce((a, fieldName) => {
      templateData[fieldName] ? a[fieldName] = templateData[fieldName] : a[fieldName] = "";
      return a
    }, {});
    // Merge objects in sort-order and return only values
    // Data-row for sheet requires nested array of strings [ [ 'John Smith', etc ] ]
    const sheetDataRow = [(
      Object.values({ 
        createdDate,
        createdTime, 
        ...templateDataSorted 
      })
    )];
    //
    // [END] Row Data: Sort & Merge
    ////////////////////////////////////////////////////////////////////////////


    /*--------------------------------------------------------------------------
      Prepare to insert data-row into app spreadsheet
    --------------------------------------------------------------------------*/

    // Get app spreadsheetId and sheetId (one spreadsheet with multiple sheets possible)
    const spreadsheetId = app.spreadsheet.id; // one spreadsheet per app
    const sheetId = app.spreadsheet.sheetId[templateName]; // multiple possible sheets

    // Authorize with google sheets
    await jwtClient.authorize();

    // Row: Add to sheet (header or data)
    const rangeHeader =  `${templateName}!A1`; // e.g. "contactDefault!A1"
    const rangeData =  `${templateName}!A2`; // e.g. "contactDefault!A2"

    const addRow = range => values => ({
      auth: jwtClient,
      spreadsheetId: spreadsheetId,
      ...range && { range }, // e.g. "contactDefault!A2"
      valueInputOption: "RAW",
      requestBody: {
        ...values && { values }
      }
    });
    
    // Row: Blank insert (sheetId argument: existing vs new sheet)
    const blankRowInsertAfterHeader = sheetId => ({
      auth: jwtClient,
      spreadsheetId: spreadsheetId,
      resource: {
        requests: [
          {
            "insertDimension": {
              "range": {
                "sheetId": sheetId,
                "dimension": "ROWS",
                "startIndex": 1,
                "endIndex": 2
              },
              "inheritFromBefore": false
            }
          }
        ]
      }
    });


    /*--------------------------------------------------------------------------
      Insert row data into sheet that matches template name
    --------------------------------------------------------------------------*/

    // Check if sheet name exists for data insert
    const sheetObjectRequest = () => ({
      auth: jwtClient,
      spreadsheetId: spreadsheetId,
      includeGridData: false
    });
    const sheetDetails = await sheets.spreadsheets.get(sheetObjectRequest());
    const sheetNameExists = sheetDetails.data.sheets.find(sheet => {
      // if sheet name exists returns sheet 'properties' object, else is undefined
      return sheet.properties.title === templateName;
    });

    // If sheet name exists, insert data
    // Else, create new sheet + insert header + insert data
    if (sheetNameExists) {
      // Insert into spreadsheet a blank row and the new data row
      await sheets.spreadsheets.batchUpdate(blankRowInsertAfterHeader(sheetId));
      await sheets.spreadsheets.values.update(addRow(rangeData)(sheetDataRow));

    } else {
      // Create new sheet, insert heder and new row data
      
      // Request object for adding sheet to existing spreadsheet
      const addSheet = () => ({
        auth: jwtClient,
        spreadsheetId: spreadsheetId,
        resource: {
          requests: [
            {
              "addSheet": {
                "properties": {
                  "title": templateName,
                  "index": 0,
                  "gridProperties": {
                    "rowCount": 1000,
                    "columnCount": 26
                  },
                }
              } 
            }
          ]
        }
      });

      // Add new sheet:
      // 'addSheet' request object returns new sheet properties
      // Get new sheetId and add to app spreadsheet info
      // newSheet returns 'data' object with properties:
      //   prop: spreadsheetId
      //   prop: replies[0].addSheet.properties (sheetId, title, index, sheetType, gridProperties { rowCount, columnCount }
      const newSheet = await sheets.spreadsheets.batchUpdate(addSheet());
      // Map 'replies' array to get sheetId
      const newSheetId = sheet => {
        const newSheet = {};
        sheet.data.replies.map(reply => newSheet.addSheet = reply.addSheet);
        return newSheet.addSheet.properties.sheetId;
      };

      // Add new sheetId to app spreadsheet info
      db.collection('app').doc(appKey).update({
        ['spreadsheet.sheetId.' + templateName]: newSheetId(newSheet)
      });

      // New Sheet Actions: add row header then row data
      await sheets.spreadsheets.values.update(addRow(rangeHeader)(headerRowSheet));
      await sheets.spreadsheets.values.update(addRow(rangeData)(sheetDataRow));

    } // end 'else' add new sheet

  } catch(error) {
    
    console.error(logErrorInfo(error));

  } // end catch

});

/*------------------------------------------------------------------------------
  Doc-Schema Trigger Cloud Functions
  When a new 'doc' is created this adds default fields/schema to it
  Parameters 'col' for collection type and 'schema' type from 'global' collection
 ------------------------------------------------------------------------------*/

const schemaDefault = (col, schema) => functions.firestore.document(`${col}/{id}`)
  .onCreate(async (snapshot, context) => {

  try {

    // Get Default Schema
    const schemaRef = await db.collection('global').doc(schema).get();
    const schemaData = schemaRef.data();

    // Update new doc with default schema
    const appRef = db.collection('app').doc(context.params.id);
    appRef.set(schemaData); // update record with 'set' which is for existing doc

  } catch(error) {
    
    console.error(logErrorInfo(error));

  }

});

// Default schema functions for 'app' and 'formTemplate' collections
module.exports = {
  schemaApp: schemaDefault('app', 'schemaApp'),
  schemaFormTemplate: schemaDefault('formTemplate', 'schemaFormTemplate')
};




/*------------------------------------------------------------------------------
  Firebase-to-Sheets Trigger Cloud Function
  Basic two column list
------------------------------------------------------------------------------*/

exports.firebaseToSheets = functions.database.ref('/Form')
  .onUpdate(async change => {

  let data = change.after.val();
  console.log("data ################ ", data);
  // Convert JSON to Array following structure below
  //
  //[
  //  ['COL-A', 'COL-B'],
  //  ['COL-A', 'COL-B']
  //]
  //
  let itemArray = [];
  let valueArray = [];
  Object.keys(data).forEach((key, index) => {
    itemArray.push(key);
    itemArray.push(data[key]);
    console.log("itemArray ############################# ", itemArray);
    valueArray[index] = itemArray;
    itemArray = [];
  });

  let maxRange = valueArray.length + 1;

  // Do authorization
  await jwtClient.authorize();
  console.log("valueArray ############################# ", valueArray) 

  // Create Google Sheets request
  let request = {
    auth: jwtClient,
    spreadsheetId: "1nOzYKj0Gr1zJPsZv-GhF00hUAJ2sTsCosMk4edJJ9nU",
    range: "Firebase!A2:B" + maxRange,
    valueInputOption: "RAW",
    requestBody: {
      values: valueArray
    }
  };
  
  // Update data to Google Sheets
  await sheets.spreadsheets.values.update(request, {});
});

