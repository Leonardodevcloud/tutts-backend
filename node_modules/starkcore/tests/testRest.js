const assert = require('assert');
const stark = require('../index.js');
const user = require('./utils/user.js');
const host = require('../starkcore/utils/host');
const rest = require('../starkcore/utils/rest.js');
const Resource = require('../starkcore/utils/resource.js').Resource

stark.user = require('./utils/user.js').exampleProject;

class Transaction extends Resource{
  constructor({ id, amount }) {    
        super(id);
        this.amount = amount;
    }
}

class Invoice extends Resource{
    constructor({id, amount, taxId, name}){
        super(id);
        this.amount = amount;
        this.taxId=taxId;
        this.name=name;
    }
}

class Webhook extends Resource {
    constructor({url, subscriptions, id = null}){
        super(id);
        this.url = url;
        this.subscriptions = subscriptions;
    }
}

class SplitProfile extends Resource {
    constructor({interval = null, delay = null, tags = null, id = null, status = null, created = null, updated = null}) {
        super(id);
        this.interval = interval;
        this.delay = delay;
        this.tags = tags;
        this.status = status;
        this.created = created;
        this.updated = updated;
    }
}

describe('testGetPage', function() {
    this.timeout(10000);
    it('test_success', async () => {
        let transactions = await rest.getPage(
            '2.13.0',
            host.bank,
            'v2',
            resource = {'class': Transaction, 'name': 'Transaction'},
            user.exampleProject,
            'pt-BR',
            2000,
            { "before": "2022-02-01", "limit": 1 }
        );
        for await (let transaction of transactions[0]) {
            assert(typeof transaction.id == 'string')
        }
    });
});


describe('testGetStream', function() {
    this.timeout(10000);
    it('test_success', async () => {
        let transactions = await rest.getList(
            '2.13.0',
            host.bank,
            "v2",
            {"class": Transaction, "name": "Transaction"},
            user.exampleProject,
            "pt-BR",
            15,
            {"limit": 2}
        )

        for await (let transaction of transactions) {
            assert(typeof transaction.id == 'string')
        }
    });
});

describe('testGetId', function() {
    this.timeout(10000);
    it('test_success', async () => {
        let transactions = await rest.getList(
            '2.13.0',
            host.bank,
            "v2",
            {"class": Transaction, "name": "Transaction"},
            user.exampleProject,
            "pt-BR",
            15,
            {"limit": 1}
        )
        
        let exampleId;
        
        for await (let transaction of transactions) {
            exampleId = transaction.id;
        }

        let request = await rest.getId(
            '2.13.0',
            host.bank,
            "v2",
            user.exampleProject,
            {"class": Transaction, "name": "Transaction"},
            exampleId,
            "pt-BR",
            15,
        )
        assert(typeof request.id == "string")
    });
});

describe('testGetContent', function() {
    this.timeout(10000);
    it('test_success', async () => {
        let invoices = await rest.getList(
            '2.13.0',
            host.bank,
            "v2",
            {"class": Invoice, "name": "Invoice"},
            user.exampleProject,
            "pt-BR",
            15,
            {"limit": 1}
        )
        
        let exampleId;
        
        for await (let invoice of invoices) {
            exampleId = invoice.id;
        }

        let pdf = await rest.getContent(
            '2.13.0',
            host.bank,
            "v2",
            user.exampleProject,
            {"class": Invoice, "name": "Invoice"},
            exampleId,
            "pdf",
            "pt-BR",
            15,
            null
        )
        assert(Buffer.isBuffer(pdf))
    });
});

describe('TestGetRaw', function(){
    this.timeout(10000); 
    it('test_success', async () => {
        path = "/invoice/";
        query={"limit": 10, "status": "paid"};
        i=0;
        list = await stark.rest.getRaw(
            '2.13.0',
            host.bank,
            "v2",
            path, 
            user.exampleProject,
            "pt-BR",
            15,
            query
        );
        for (let invoice of list["content"]["invoices"]) {
            assert(typeof invoice.id == 'string');
            i += 1;
        }
        assert(i === 10);
    });
});

describe('TestPostRaw', function(){
    this.timeout(10000); 
    it('test_success', async () => {
        const path = "/invoice/";
        const data={
            "invoices": [{
                "amount": 100,
                "name": "Iron Bank S.A.",
                "taxId": "20.018.183/0001-80"
            }]
        };
        let request = await stark.rest.postRaw(
            '2.13.0',
            host.bank,
            "v2",
            path, 
            data,
            user.exampleProject,
            "pt-BR",
            15,
        );
        assert(request["content"]["invoices"][0]["taxId"] == "20.018.183/0001-80")
    });
});

describe('TestRequestPatch', function(){
    this.timeout(10000); 
    it('test_success', async () => {
        i=0;
        list = await stark.rest.getRaw(
            '2.13.0',
            host.bank,
            "v2",
            "/invoice/", 
            user.exampleProject,
            "pt-BR",
            15,
            {"limit": 1, "status": "paid"}
        );
        let exampleId;
        let amount;
        for (let invoice of list["content"]["invoices"]) {
            exampleId = invoice.id;
            amount = invoice.amount;
        }

        await stark.rest.patchRaw(
            '2.13.0',
            host.bank,
            "v2",
            `/invoice/${exampleId}`, 
            {"amount": 0},
            user.exampleProject,
            "pt-BR",
            15,
        );
        const finalState = await stark.rest.getRaw(
            '2.13.0',
            host.bank,
            "v2",
            `/invoice/${exampleId}`, 
            user.exampleProject,
            "pt-BR",
            15,
        );
        assert(finalState["content"]["invoice"]["amount"] == 0)
    });
});

describe('TestPut', function(){
    this.timeout(10000);
    it('test_success', async () => {
        data = {
            "profiles": [
                {
                    "interval": "day",
                    "delay": 0
                }
            ]
        };
        await stark.rest.putRaw(
            '2.13.0',
            host.bank,
            "v2",
            "/split-profile/",
            data,
            user.exampleProject,
            "pt-BR",
            15,
        )

        result = await stark.rest.getRaw(
            '2.13.0',
            host.bank,
            "v2",
            "/split-profile/",
            user.exampleProject,
            "pt-BR",
            15,
        )
        assert(result["content"]["profiles"][0]["delay"] == 0)
    })
})

describe('TestPutMulti', function() {
    this.timeout(10000);
    it('test_success', async () => {
        data = [{
            interval: "week",
            delay: 2
        }];
        let profiles = await rest.putMulti(
            '2.13.0',
            host.bank,
            'v2',
            user.exampleProject,
            resource = {'class': SplitProfile, 'name': 'SplitProfile'},
            data,
            'pt-BR',
            2000,
            null
        );

        assert(profiles[0].delay == 2);
        assert(profiles[0].interval == "week");
    })
});

describe('TestDelete', function(){
    this.timeout(10000); 
    it('test_success', async () => {
        let future_date = new Date();
        future_date.setDate(future_date.getDate() + 10);
       
        data = {
            "transfers": [
                {
                    "amount": 10000,
                    "name": "Steve Rogers",
                    "taxId": "330.731.970-10",
                    "bankCode": "001",
                    "branchCode": "1234",
                    "accountNumber": "123456-0",
                    "accountType": "checking",
                    "scheduled": future_date.toISOString().split("T")[0],
                    "externalId": new Date().getTime().toString(),
                }
            ]
        }

        create = await stark.rest.postRaw(
            '2.13.0',
            host.bank,
            "v2",
            "/transfer/",
            data,
            user.exampleProject,
            "pt-BR",
            15,
        )

        await stark.rest.deleteRaw(
            '2.13.0',
            host.bank,
            "v2",
            `/transfer/${create["content"]["transfers"][0]["id"]}`,
            data,
            user.exampleProject,
            "pt-BR",
            15,
        )
        const final_status = await stark.rest.getRaw(
            '2.13.0',
            host.bank,
            "v2",
            `/transfer/${create["content"]["transfers"][0]["id"]}`, 
            user.exampleProject,
            "pt-BR",
            15,
        );
        assert(final_status["content"]["transfer"]["status"] == 'canceled')
    })
});
