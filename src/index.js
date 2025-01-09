const { app } = require('@azure/functions');
// const df = require("durable-functions");

// module.exports = df.entity(function(context) {
//     const currentValue = context.df.getState(() => 0);
//     switch (context.df.operationName) {
//         case "set":
//             const amount = context.df.getInput();
//             context.df.setState(amount);
//             break;
//         case "get":
//             context.df.return(currentValue);
//             break;
//     }
// });

app.setup({
    enableHttpStream: true,
});
