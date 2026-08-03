function createCode(length){

    const chars =
    "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    let result = "";


    for(let i = 0; i < length; i++){

        result += chars[
            Math.floor(Math.random() * chars.length)
        ];

    }


    return result;

}


module.exports = createCode;