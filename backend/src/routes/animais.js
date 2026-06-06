const { Router } = require('express');
const controller = require('../controllers/animaisController');

const router = Router();

router.get('/',          controller.listar);
router.get('/:id',       controller.buscarPorId);
router.post('/',         controller.criar);
router.put('/:id',       controller.atualizar);
router.delete('/:id',    controller.remover);
router.patch('/:id/status', controller.toggleStatus);
router.post('/:id/adotar', controller.adotar);

module.exports = router;
