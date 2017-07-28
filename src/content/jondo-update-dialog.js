function TorOffOk(){
	try{
		window.arguments[0].out = "ok";
		window.top.document.getElementById("jondo-update-dialog").acceptDialog();
	}catch(e){
	}
	
	return true;
}

function TorOffCancel(){
	try{
		window.arguments[0].out = "cancel";
		window.top.document.getElementById("jondo-update-dialog").cancelDialog();
	}catch(e){}
	
	return true;
}